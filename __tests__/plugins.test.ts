import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPluginRegistry, PluginConfigurationError } from '../src/plugins';
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
});
