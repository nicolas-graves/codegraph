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

const PLUGIN_ENTRY_FILENAME = 'codegraph-plugin.cjs';

/**
 * Scan `directories` (already split from GUIX_CODEGRAPH_PLUGINS) for
 * `codegraph-plugin.cjs` entry files, at most one level deep: a file directly
 * inside a directory, or inside any of its immediate subdirectories — never
 * deeper. This matches Guix's directory-type native-search-paths: each
 * profile package contributes one shared directory name (e.g.
 * `share/codegraph-plugins`), and a package nests its own plugin one level
 * under it (e.g. `guix/codegraph-plugin.cjs`) so two unrelated packages
 * sharing that directory name never collide on the entry filename.
 *
 * A missing, unreadable, or non-directory entry is silently skipped — this
 * scan must never turn "nothing installed" into an error. Returns absolute
 * paths, sorted and de-duplicated, so the resulting plugin set — and
 * therefore isIndexStale()'s fingerprint — never depends on readdir order.
 *
 * De-duplication follows realpath, not the literal directory string: it's
 * routine for the SAME underlying store item to be reachable through two
 * different GUIX_CODEGRAPH_PLUGINS entries at once — e.g. a shell that
 * sources a Guix profile's `etc/profile` more than once (a `.zshenv`
 * unconditional load plus a login `.zprofile`/`/etc/profile` load is
 * standard `guix home` output) ends up with that profile's
 * `share/codegraph-plugins` directory listed twice, once per literal
 * spelling (resolved store-hash path vs. the `~/.guix-home/profile`
 * symlink). Those are two paths to one file, not two competing packages —
 * exactly how PATH/GUILE_LOAD_PATH/etc. already tolerate repeated
 * directories from the same profile. Only the lexicographically-first
 * literal path survives (keeps the result independent of directory order);
 * a genuine same-name collision between two DIFFERENT files is left for
 * loadEffectivePluginRegistry to reject.
 */
export function discoverPluginSpecifiers(directories: readonly string[]): string[] {
  const found = new Set<string>();
  for (const dir of directories) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let isFile = entry.isFile();
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const target = fs.statSync(full);
          isFile = target.isFile();
          isDirectory = target.isDirectory();
        } catch {
          continue; // broken symlink
        }
      }
      if (isFile && entry.name === PLUGIN_ENTRY_FILENAME) {
        found.add(full);
      } else if (isDirectory) {
        const nested = path.join(full, PLUGIN_ENTRY_FILENAME);
        if (fs.statSync(nested, { throwIfNoEntry: false })?.isFile()) found.add(nested);
      }
    }
  }
  const seenRealPaths = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of [...found].sort()) {
    let real: string;
    try { real = fs.realpathSync(candidate); } catch { real = candidate; }
    if (seenRealPaths.has(real)) continue;
    seenRealPaths.add(real);
    deduped.push(candidate);
  }
  return deduped;
}

/** Split GUIX_CODEGRAPH_PLUGINS-style env values on path.delimiter, dropping blanks. */
export function resolveEnvPluginDirectories(envVal: string | undefined): string[] {
  return (envVal ?? '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);
}

/**
 * Build the effective plugin registry: explicit codegraph.json "plugins"
 * (fatal on error, unchanged) plus codegraph-plugin.cjs files auto-discovered
 * from `envDirectories` (GUIX_CODEGRAPH_PLUGINS — see README "Trusted
 * plugins"). Precedence and de-dup:
 *
 *   1. Explicit specifiers always load, in declared order, fatal on error —
 *      exactly as today.
 *   2. An auto-discovered candidate whose resolved absolute path exactly
 *      matches an already-explicit absolute-path specifier is dropped, not
 *      re-loaded — keeps a codegraph.json that still hardcodes an old
 *      plugin's store path from hitting PluginRegistry's "duplicate plugin
 *      name" error during migration.
 *   3. Remaining candidates are individually probe-loaded. One that fails to
 *      load or validate is logged as a warning and skipped, NOT fatal —
 *      unlike an explicit entry, nobody reviewed this file for this project.
 *   4. A probed candidate whose declared plugin `name` matches an already
 *      explicit plugin's name is ALSO dropped with a warning rather than
 *      loaded — even at a different resolved path. This is the common
 *      migration case: a project's codegraph.json still hardcodes an old
 *      build's store path for the same logical plugin a Guix profile now
 *      also provides via auto-discovery. Unlike two independently-valid
 *      auto-discovered plugins colliding (no principled winner — stays
 *      fatal below), an explicit codegraph.json entry IS the project's
 *      already-stated choice, so the auto-discovered same-named plugin is
 *      redundant, not a genuine conflict.
 *   5. Every remaining candidate is appended after the explicit entries, in
 *      sorted-path order.
 *
 * A name collision between two ACCEPTED auto-discovered plugins remains a
 * fatal PluginConfigurationError from the final loadPluginRegistry call —
 * there's no principled way to silently pick a winner between two
 * independently-valid profile-installed packages.
 */
export function loadEffectivePluginRegistry(
  projectRoot: string,
  explicitSpecifiers: readonly string[],
  envDirectories: readonly string[] = []
): PluginRegistry {
  const explicitRegistry = loadPluginRegistry(projectRoot, explicitSpecifiers); // fatal on error, unchanged
  const explicitResolvedPaths = new Set(
    explicitSpecifiers.filter((s) => path.isAbsolute(s)).map((s) => path.resolve(s))
  );
  const explicitNames = new Set(explicitRegistry.plugins.map((p) => p.plugin.name));

  const candidates = discoverPluginSpecifiers(envDirectories)
    .filter((c) => !explicitResolvedPaths.has(path.resolve(c)));

  const accepted: string[] = [];
  for (const candidate of candidates) {
    let probed: PluginRegistry;
    try {
      probed = loadPluginRegistry(projectRoot, [candidate]); // probe only; require() cache makes the real load below free
    } catch (err) {
      logWarn(`Ignoring auto-discovered CodeGraph plugin: ${err instanceof Error ? err.message : String(err)}`, { candidate });
      continue;
    }
    const name = probed.plugins[0]?.plugin.name;
    if (name !== undefined && explicitNames.has(name)) {
      logWarn(`Ignoring auto-discovered CodeGraph plugin "${name}": already loaded explicitly via codegraph.json`, { candidate });
      continue;
    }
    accepted.push(candidate);
  }
  return loadPluginRegistry(projectRoot, [...explicitSpecifiers, ...accepted]);
}
