const path = require('path');

function bundleManifest(manifest) {
  if (!manifest || !Array.isArray(manifest.files) || !manifest.files.length) {
    throw new Error('src/manifest.json must contain a non-empty files array');
  }
  if (manifest.lazy != null && (typeof manifest.lazy !== 'object' || Array.isArray(manifest.lazy))) {
    throw new Error('manifest.lazy must map output filenames to source arrays');
  }
  const bundles = [{ out: 'script.js', files: manifest.files },
    ...Object.entries(manifest.lazy || {}).map(([out, files]) => ({ out, files }))];
  const seenSources = new Set();
  const seenOutputs = new Set();
  for (const bundle of bundles) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.js$/.test(bundle.out) || seenOutputs.has(bundle.out.toLowerCase())) {
      throw new Error(`Unsafe or duplicate bundle output: ${bundle.out}`);
    }
    seenOutputs.add(bundle.out.toLowerCase());
    if (!Array.isArray(bundle.files) || !bundle.files.length) throw new Error(`Empty source list for ${bundle.out}`);
    for (const file of bundle.files) {
      if (typeof file !== 'string' || !file.endsWith('.js') || file.includes('\\') || file.includes(':') ||
          path.posix.isAbsolute(file) || path.posix.normalize(file) !== file || file.startsWith('../')) {
        throw new Error(`Unsafe source path: ${file}`);
      }
      if (seenSources.has(file.toLowerCase())) throw new Error(`Duplicate source module: ${file}`);
      seenSources.add(file.toLowerCase());
    }
  }
  return bundles;
}

module.exports = { bundleManifest };
