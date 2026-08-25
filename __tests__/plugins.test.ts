import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverPluginSpecifiers, loadEffectivePluginRegistry, loadPluginRegistry, PluginConfigurationError } from '../src/plugins';
import CodeGraph from '../src/index';

const dirs: string[] = [];
function fixture(body: string, grammar = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-plugin-'));
  dirs.push(root);
  if (grammar) fs.writeFileSync(path.join(root, 'grammar.wasm'), 'wasm');
  fs.writeFileSync(path.join(root, 'plugin.cjs'), body);
  return root;
}

const extractor = `{
  functionTypes: [], classTypes: [], methodTypes: [], interfaceTypes: [], structTypes: [],
  enumTypes: [], typeAliasTypes: [], importTypes: [], callTypes: [], variableTypes: []
}`;

afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('external plugin registry', () => {
  it('resolves a relative CommonJS plugin and grammar from its entry point', () => {
    const root = fixture(`module.exports={apiVersion:1,name:'guix',languages:[{id:'scheme',extensions:['.scm'],grammar:'./grammar.wasm',extractor:${extractor}}]}`);
    const registry = loadPluginRegistry(root, ['./plugin.cjs']);
    expect(registry.detectLanguage('gnu/packages/base.scm')).toBe('scheme');
    expect(registry.getLanguage('scheme')?.grammar).toBe(path.join(root, 'grammar.wasm'));
    expect(registry.getExtractor('scheme')).toBeTruthy();
  });

  it('rejects incompatible APIs and missing grammars with actionable errors', () => {
    let root = fixture(`module.exports={apiVersion:2,name:'future'}`);
    expect(() => loadPluginRegistry(root, ['./plugin.cjs'])).toThrow(/apiVersion.*expected 1/);
    root = fixture(`module.exports={apiVersion:1,name:'bad',languages:[{id:'scheme',extensions:['.scm'],grammar:'./missing.wasm',extractor:${extractor}}]}`, false);
    expect(() => loadPluginRegistry(root, ['./plugin.cjs'])).toThrow(/grammar does not exist/);
  });

  it('rejects built-in ids, extension collisions, duplicate plugin names, and malformed extractors', () => {
    let root = fixture(`module.exports={apiVersion:1,name:'bad',languages:[{id:'python',extensions:['.scm'],grammar:'./grammar.wasm',extractor:${extractor}}]}`);
    expect(() => loadPluginRegistry(root, ['./plugin.cjs'])).toThrow(/duplicate language id/);
    root = fixture(`module.exports={apiVersion:1,name:'bad',languages:[{id:'scheme',extensions:['.py'],grammar:'./grammar.wasm',extractor:${extractor}}]}`);
    expect(() => loadPluginRegistry(root, ['./plugin.cjs'])).toThrow(/extension.*collides/);
    root = fixture(`module.exports={apiVersion:1,name:'bad',languages:[{id:'scheme',extensions:['.scm'],grammar:'./grammar.wasm',extractor:{}}]}`);
    expect(() => loadPluginRegistry(root, ['./plugin.cjs'])).toThrow(/malformed extractor/);
    const second = path.join(root, 'second.cjs');
    fs.writeFileSync(second, `module.exports={apiVersion:1,name:'bad'}`);
    expect(() => loadPluginRegistry(root, ['./plugin.cjs', './second.cjs'])).toThrow(PluginConfigurationError);
  });

  it('keeps simultaneous project registries isolated and permits explicit overrides', () => {
    const a = fixture(`module.exports={apiVersion:1,name:'a',languages:[{id:'scheme',extensions:['.scm'],grammar:'./grammar.wasm',extractor:${extractor}}]}`);
    const b = fixture(`module.exports={apiVersion:1,name:'b',languages:[{id:'elisp',extensions:['.el'],grammar:'./grammar.wasm',extractor:${extractor}}]}`);
    const ra = loadPluginRegistry(a, ['./plugin.cjs']);
    const rb = loadPluginRegistry(b, ['./plugin.cjs']);
    expect(ra.detectLanguage('x.scm')).toBe('scheme');
    expect(rb.detectLanguage('x.scm')).toBeUndefined();
    expect(ra.extensionMap({ '.scm': 'javascript' })['.scm']).toBe('javascript');
    expect(ra.extensionMap({ '.foo': 'missing-language' })['.foo']).toBeUndefined();
  });
});

describe('auto-discovered plugins (GUIX_CODEGRAPH_PLUGINS)', () => {
  // A discovery-root directory, matching the layout GUIX_CODEGRAPH_PLUGINS
  // entries actually have: either `codegraph-plugin.cjs` directly inside
  // (flat), or nested one level under a named subdirectory (mirrors Guix's
  // `share/codegraph-plugins/guix/codegraph-plugin.cjs`).
  function discoveryRoot(body: string, opts: { nested?: string; grammar?: boolean } = {}): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-plugin-discover-'));
    dirs.push(root);
    const dir = opts.nested ? path.join(root, opts.nested) : root;
    fs.mkdirSync(dir, { recursive: true });
    if (opts.grammar !== false) fs.writeFileSync(path.join(dir, 'grammar.wasm'), 'wasm');
    fs.writeFileSync(path.join(dir, 'codegraph-plugin.cjs'), body);
    return root;
  }

  const validBody = `module.exports={apiVersion:1,name:'discovered',languages:[{id:'guix',extensions:['.gscm'],grammar:'./grammar.wasm',extractor:${extractor}}]}`;

  it('is a no-op for a directory that does not exist', () => {
    expect(discoverPluginSpecifiers(['/nonexistent/codegraph-plugin-dir'])).toEqual([]);
  });

  it('finds a plugin directly inside a discovery root (flat layout)', () => {
    const root = discoveryRoot(validBody);
    expect(discoverPluginSpecifiers([root])).toEqual([path.join(root, 'codegraph-plugin.cjs')]);
  });

  it('finds a plugin one level down but not two (nested layout, matching Guix share/codegraph-plugins/<name>/)', () => {
    const root = discoveryRoot(validBody, { nested: 'guix' });
    expect(discoverPluginSpecifiers([root])).toEqual([path.join(root, 'guix', 'codegraph-plugin.cjs')]);

    const tooDeep = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-plugin-discover-'));
    dirs.push(tooDeep);
    fs.mkdirSync(path.join(tooDeep, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(tooDeep, 'a', 'b', 'codegraph-plugin.cjs'), validBody);
    expect(discoverPluginSpecifiers([tooDeep])).toEqual([]);
  });

  it('returns candidates sorted and de-duplicated regardless of directory order', () => {
    const rootA = discoveryRoot(validBody, { nested: 'a-plugin' });
    const rootB = discoveryRoot(validBody, { nested: 'b-plugin' });
    const specifiers = discoverPluginSpecifiers([rootB, rootA]);
    expect(specifiers).toEqual([...specifiers].sort());
    expect(specifiers).toHaveLength(2);
  });

  it('loads a discovered plugin end-to-end via loadEffectivePluginRegistry', () => {
    const root = discoveryRoot(validBody, { nested: 'guix' });
    const registry = loadEffectivePluginRegistry(root, [], [root]);
    expect(registry.detectLanguage('x.gscm')).toBe('guix');
  });

  it('an explicit codegraph.json entry at the same resolved path wins over discovery, without a duplicate-name error', () => {
    const root = discoveryRoot(validBody, { nested: 'guix' });
    const explicitPath = path.join(root, 'guix', 'codegraph-plugin.cjs');
    expect(() => loadEffectivePluginRegistry(root, [explicitPath], [root])).not.toThrow();
    const registry = loadEffectivePluginRegistry(root, [explicitPath], [root]);
    expect(registry.plugins).toHaveLength(1);
  });

  it('a broken auto-discovered plugin is skipped with a warning, not fatal, and does not block a valid explicit plugin', () => {
    const broken = discoveryRoot(`module.exports={apiVersion:2,name:'future'}`);
    const explicitRoot = fixture(`module.exports={apiVersion:1,name:'explicit',languages:[{id:'scheme',extensions:['.scm'],grammar:'./grammar.wasm',extractor:${extractor}}]}`);
    const registry = loadEffectivePluginRegistry(explicitRoot, ['./plugin.cjs'], [broken]);
    expect(registry.detectLanguage('x.scm')).toBe('scheme');
    expect(registry.plugins.map((p) => p.plugin.name)).toEqual(['explicit']);
  });

  it('two accepted auto-discovered plugins sharing a name still throws', () => {
    const rootA = discoveryRoot(
      `module.exports={apiVersion:1,name:'clash',languages:[{id:'guix',extensions:['.gscm'],grammar:'./grammar.wasm',extractor:${extractor}}]}`,
      { nested: 'a' }
    );
    const rootB = discoveryRoot(
      `module.exports={apiVersion:1,name:'clash',languages:[{id:'guile',extensions:['.gil'],grammar:'./grammar.wasm',extractor:${extractor}}]}`,
      { nested: 'b' }
    );
    expect(() => loadEffectivePluginRegistry(rootA, [], [rootA, rootB])).toThrow(/duplicate plugin name/);
  });

  it('with no env directories, behaves identically to loadPluginRegistry (no auto-discovery is the zero-config default)', () => {
    const root = fixture(`module.exports={apiVersion:1,name:'explicit-only',languages:[{id:'scheme',extensions:['.scm'],grammar:'./grammar.wasm',extractor:${extractor}}]}`);
    const a = loadEffectivePluginRegistry(root, ['./plugin.cjs'], []);
    const b = loadPluginRegistry(root, ['./plugin.cjs']);
    expect(a.plugins.map((p) => p.plugin.name)).toEqual(b.plugins.map((p) => p.plugin.name));
  });
});

describe('external plugin end-to-end indexing (#1552)', () => {
  // A real vendored grammar + a real extractor (reusing python's, since a
  // plugin-only language exercises the exact same extraction path) — unlike
  // the registry-only tests above, this drives full CodeGraph.indexAll /
  // sync / getChangedFiles so it catches bugs where the plugin registry
  // loads fine but individual pipeline stages fall back to the built-in,
  // non-registry-aware helpers and silently treat the plugin language as
  // unsupported.
  const pyWasm = require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm');
  // Same shape as src/extraction/languages/python.ts's pythonExtractor, inlined
  // as a plain object literal so the plugin fixture has no dependency on dist/.
  const pyExtractorLiteral = `{
    functionTypes: ['function_definition'], classTypes: ['class_definition'],
    methodTypes: ['function_definition'], interfaceTypes: [], structTypes: [],
    enumTypes: [], typeAliasTypes: [], importTypes: ['import_statement', 'import_from_statement'],
    callTypes: ['call'], variableTypes: ['assignment'],
    nameField: 'name', bodyField: 'body', paramsField: 'parameters',
  }`;

  function project(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-plugin-e2e-'));
    dirs.push(root);
    fs.writeFileSync(
      path.join(root, 'plugin.cjs'),
      `module.exports = { apiVersion: 1, name: 'py-plugin-test', languages: [{
        id: 'pyplugintest', extensions: ['.pyplug'], grammar: ${JSON.stringify(pyWasm)},
        extractor: ${pyExtractorLiteral},
      }] };`
    );
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ plugins: ['./plugin.cjs'] }));
    fs.writeFileSync(path.join(root, 'greet.pyplug'), `def greet(name):\n    return helper(name)\n\ndef helper(name):\n    return "hi " + name\n`);
    return root;
  }

  it('indexes a plugin-only language and keeps it stable across sync (regression: sync/getChangedFiles used to drop it as removed)', async () => {
    const root = project();
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const status1 = cg.getChangedFiles();
      expect(status1.removed).toHaveLength(0);
      expect(status1.added).toHaveLength(0);
      expect(status1.modified).toHaveLength(0);

      const sync1 = await cg.sync();
      expect(sync1.filesRemoved).toBe(0);
      expect(sync1.filesAdded).toBe(0);
      expect(sync1.filesModified).toBe(0);

      const found = cg.searchNodes('helper');
      expect(found.some((r) => r.node.name === 'helper')).toBe(true);
    } finally {
      cg.destroy();
    }
  });

  it('re-extracts a plugin-language file on edit instead of silently no-oping (regression: indexFileWithContent used the non-registry-aware isLanguageSupported/extractFromSource)', async () => {
    const root = project();
    const cg = await CodeGraph.init(root, { index: true });
    try {
      fs.appendFileSync(path.join(root, 'greet.pyplug'), `\ndef farewell(name):\n    return "bye " + name\n`);
      const sync = await cg.sync();
      expect(sync.filesModified).toBe(1);
      expect(sync.nodesUpdated).toBeGreaterThan(0);

      const found = cg.searchNodes('farewell');
      expect(found.some((r) => r.node.name === 'farewell')).toBe(true);

      // A second sync must be a true no-op, not perpetually "modified".
      const sync2 = await cg.sync();
      expect(sync2.filesModified).toBe(0);
    } finally {
      cg.destroy();
    }
  });

  it('indexes a plugin discovered purely via GUIX_CODEGRAPH_PLUGINS, with no codegraph.json plugins entry at all', async () => {
    const discoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-plugin-envdisc-'));
    dirs.push(discoveryDir);
    const pluginDir = path.join(discoveryDir, 'guix');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'codegraph-plugin.cjs'),
      `module.exports = { apiVersion: 1, name: 'py-plugin-env-test', languages: [{
        id: 'pypluginenvtest', extensions: ['.pyplugenv'], grammar: ${JSON.stringify(pyWasm)},
        extractor: ${pyExtractorLiteral},
      }] };`
    );

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-plugin-e2e-env-'));
    dirs.push(root);
    fs.writeFileSync(path.join(root, 'greet.pyplugenv'), `def greet(name):\n    return helper(name)\n\ndef helper(name):\n    return "hi " + name\n`);

    const previous = process.env.GUIX_CODEGRAPH_PLUGINS;
    process.env.GUIX_CODEGRAPH_PLUGINS = discoveryDir;
    let cg: CodeGraph | undefined;
    try {
      cg = await CodeGraph.init(root, { index: true });
      const found = cg.searchNodes('helper');
      expect(found.some((r) => r.node.name === 'helper')).toBe(true);
    } finally {
      cg?.destroy();
      if (previous === undefined) delete process.env.GUIX_CODEGRAPH_PLUGINS;
      else process.env.GUIX_CODEGRAPH_PLUGINS = previous;
    }
  });
});
