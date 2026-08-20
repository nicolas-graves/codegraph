/** Public, versioned API and project-scoped registry for trusted CodeGraph plugins. */
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { LANGUAGES, type Language } from './types';
import type { LanguageExtractor } from './extraction/tree-sitter-types';
import type { FrameworkResolver } from './resolution/types';
import { EXTENSION_MAP } from './extraction/grammars';
import { EXTRACTORS } from './extraction/languages';
import { getAllFrameworkResolvers } from './resolution/frameworks';
import { logWarn } from './errors';

export interface LanguagePlugin {
  id: string;
  extensions: string[];
  /** Relative to the plugin entry point. Rewritten to an absolute path by the loader. */
  grammar: string;
  extractor: LanguageExtractor;
  displayName?: string;
}

export interface CodeGraphPlugin {
  apiVersion: 1;
  name: string;
  languages?: LanguagePlugin[];
  frameworks?: FrameworkResolver[];
}

export class PluginConfigurationError extends Error {
  constructor(message: string) { super(`Invalid CodeGraph plugin configuration: ${message}`); this.name = 'PluginConfigurationError'; }
}

export interface LoadedPlugin { specifier: string; entryPoint: string; plugin: CodeGraphPlugin; version?: string }

const REQUIRED_EXTRACTOR_ARRAYS = [
  'functionTypes', 'classTypes', 'methodTypes', 'interfaceTypes', 'structTypes',
  'enumTypes', 'typeAliasTypes', 'importTypes', 'callTypes', 'variableTypes',
] as const;

function validExtractor(value: unknown): value is LanguageExtractor {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return REQUIRED_EXTRACTOR_ARRAYS.every((key) => Array.isArray(e[key]) && (e[key] as unknown[]).every((x) => typeof x === 'string'));
}

function normalizeExtension(ext: unknown, owner: string): string {
  if (typeof ext !== 'string' || !/^\.[^./\\]+$/.test(ext.trim())) {
    throw new PluginConfigurationError(`${owner} declares invalid extension ${JSON.stringify(ext)}`);
  }
  return ext.trim().toLowerCase();
}

/** Immutable built-ins plus contributions loaded for exactly one project. */
export class PluginRegistry {
  private readonly languages = new Map<string, LanguagePlugin>();
  private readonly extensions = new Map<string, Language>();
  private readonly extractors = new Map<string, LanguageExtractor>();
  private readonly frameworks = new Map<string, FrameworkResolver>();
  readonly plugins: LoadedPlugin[];

  constructor(plugins: LoadedPlugin[] = []) {
    for (const [ext, lang] of Object.entries(EXTENSION_MAP)) this.extensions.set(ext, lang);
    for (const [id, extractor] of Object.entries(EXTRACTORS)) if (extractor) this.extractors.set(id, extractor);
    for (const framework of getAllFrameworkResolvers()) this.frameworks.set(framework.name, framework);
    this.plugins = Object.freeze([...plugins]) as LoadedPlugin[];
    const pluginNames = new Set<string>();
    for (const loaded of plugins) {
      const plugin = loaded.plugin;
      if (pluginNames.has(plugin.name)) throw new PluginConfigurationError(`duplicate plugin name "${plugin.name}"`);
      pluginNames.add(plugin.name);
      for (const language of plugin.languages ?? []) this.registerLanguage(plugin.name, language);
      for (const framework of plugin.frameworks ?? []) this.registerFramework(plugin.name, framework);
    }
  }

  private registerLanguage(owner: string, language: LanguagePlugin): void {
    if (!language || typeof language.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(language.id))
      throw new PluginConfigurationError(`${owner} declares an invalid language id`);
    if ((LANGUAGES as readonly string[]).includes(language.id) || this.languages.has(language.id))
      throw new PluginConfigurationError(`${owner} attempts to replace duplicate language id "${language.id}"`);
    if (!path.isAbsolute(language.grammar) || !fs.statSync(language.grammar, { throwIfNoEntry: false })?.isFile())
      throw new PluginConfigurationError(`${owner} language "${language.id}" grammar does not exist: ${language.grammar}`);
    if (!validExtractor(language.extractor))
      throw new PluginConfigurationError(`${owner} language "${language.id}" has a malformed extractor`);
    for (const raw of language.extensions) {
      const ext = normalizeExtension(raw, `${owner} language "${language.id}"`);
      if (this.extensions.has(ext)) throw new PluginConfigurationError(`${owner} extension "${ext}" collides with language "${this.extensions.get(ext)}"; use codegraph.json extensions to reassign it explicitly`);
      this.extensions.set(ext, language.id);
    }
    this.languages.set(language.id, Object.freeze({ ...language, extensions: [...language.extensions] }));
    this.extractors.set(language.id, language.extractor);
  }

  private registerFramework(owner: string, framework: FrameworkResolver): void {
    if (!framework || typeof framework.name !== 'string' || typeof framework.detect !== 'function')
      throw new PluginConfigurationError(`${owner} declares a malformed framework resolver`);
    if (this.frameworks.has(framework.name)) throw new PluginConfigurationError(`${owner} attempts to replace duplicate framework id "${framework.name}"`);
    this.frameworks.set(framework.name, framework);
  }

  detectLanguage(file: string): Language | undefined { return this.extensions.get(path.extname(file).toLowerCase()); }
  isSourceFile(file: string): boolean { return this.detectLanguage(file) !== undefined; }
  isLanguageSupported(id: string): boolean { return this.extensionsHasLanguage(id); }
  private extensionsHasLanguage(id: string): boolean { return (LANGUAGES as readonly string[]).includes(id) || this.languages.has(id); }
  getLanguage(id: string): LanguagePlugin | undefined { return this.languages.get(id); }
  getExtractor(id: string): LanguageExtractor | undefined { return this.extractors.get(id); }
  getFrameworks(): FrameworkResolver[] { return [...this.frameworks.values()]; }
  getSupportedLanguages(): string[] { return [...LANGUAGES, ...this.languages.keys()]; }
  grammarPaths(): Record<string, string> { return Object.fromEntries([...this.languages].map(([id, l]) => [id, l.grammar])); }
  fingerprint(): string {
    const normalized = this.plugins.map((p) => ({ specifier: p.specifier, name: p.plugin.name, version: p.version ?? null }));
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }
  extensionMap(overrides: Record<string, Language> = {}): Record<string, Language> {
    const out = { ...Object.fromEntries(this.extensions) };
    for (const [ext, language] of Object.entries(overrides)) {
      if (!this.isLanguageSupported(language)) {
        logWarn(`Ignoring extension "${ext}" override: "${language}" is not a supported language`);
        continue;
      }
      out[ext] = language;
    }
    return out;
  }
}

function resolveEntry(root: string, specifier: string): string {
  const req = createRequire(path.join(root, '__codegraph_plugin_loader__.js'));
  try { return req.resolve(specifier.startsWith('.') || path.isAbsolute(specifier) ? path.resolve(root, specifier) : specifier); }
  catch (err) { throw new PluginConfigurationError(`cannot resolve "${specifier}" from ${root}: ${err instanceof Error ? err.message : String(err)}`); }
}

export function loadPluginRegistry(projectRoot: string, specifiers: readonly string[] = []): PluginRegistry {
  const req = createRequire(path.join(projectRoot, '__codegraph_plugin_loader__.js'));
  const loaded: LoadedPlugin[] = [];
  for (const specifier of specifiers) {
    const entryPoint = resolveEntry(projectRoot, specifier);
    let exported: unknown;
    try { exported = req(entryPoint); } catch (err) { throw new PluginConfigurationError(`failed to load "${specifier}": ${err instanceof Error ? err.message : String(err)}`); }
    const rawPlugin = ((exported as { default?: unknown })?.default ?? exported) as Partial<CodeGraphPlugin>;
    if (!rawPlugin || typeof rawPlugin !== 'object' || rawPlugin.apiVersion !== 1)
      throw new PluginConfigurationError(`"${specifier}" uses unsupported apiVersion ${JSON.stringify(rawPlugin?.apiVersion)} (expected 1)`);
    if (typeof rawPlugin.name !== 'string' || !rawPlugin.name.trim()) throw new PluginConfigurationError(`"${specifier}" has no valid name`);
    const languages: LanguagePlugin[] = [];
    for (const language of rawPlugin.languages ?? []) {
      if (!language || typeof language.grammar !== 'string') throw new PluginConfigurationError(`${rawPlugin.name} declares a language without a grammar path`);
      languages.push({ ...language, extensions: [...language.extensions], grammar: path.resolve(path.dirname(entryPoint), language.grammar) });
    }
    const plugin: CodeGraphPlugin = { ...rawPlugin, apiVersion: 1, name: rawPlugin.name, languages, frameworks: rawPlugin.frameworks ? [...rawPlugin.frameworks] : undefined };
    let version: string | undefined;
    try { version = req(path.join(path.dirname(entryPoint), 'package.json')).version; } catch { /* local single-file plugin */ }
    loaded.push({ specifier, entryPoint, plugin: plugin as CodeGraphPlugin, version });
  }
  return new PluginRegistry(loaded);
}
