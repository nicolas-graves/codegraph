import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadPluginRegistry, PluginConfigurationError } from '../src/plugins';

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
