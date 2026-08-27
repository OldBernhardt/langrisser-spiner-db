const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const parentDirectory = path.resolve(__dirname, '..');
const defaultRepository = fs.existsSync(path.join(parentDirectory, 'data.json'))
  ? parentDirectory
  : path.join(__dirname, 'langrisser-spiner-db-pr');
const repositoryDirectory = path.resolve(process.argv[2] || defaultRepository);
const data = JSON.parse(fs.readFileSync(path.join(repositoryDirectory, 'data.json'), 'utf8'));
const remotePaths = new Set(childProcess.execFileSync(
  'git',
  ['-C', repositoryDirectory, 'ls-tree', '-r', '--name-only', 'HEAD'],
  { encoding: 'utf8' },
).split(/\r?\n/).filter(Boolean));
const errors = [];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const localFiles = ['char', 'confession'].flatMap((root) => walk(path.join(repositoryDirectory, root)));
const localPaths = new Set(localFiles.map((filePath) =>
  path.relative(repositoryDirectory, filePath).split(path.sep).join('/'),
));
const referenceCounts = new Map();
let variantCount = 0;
let completeVariantCount = 0;

for (const [rootName, outers] of Object.entries(data)) {
  for (const [outerName, variants] of Object.entries(outers)) {
    for (const [variantName, variant] of Object.entries(variants)) {
      variantCount++;
      const expectedComplete = ['atlas', 'png', 'skel'].every((field) => field in variant.files);
      if (variant.complete !== expectedComplete) {
        errors.push(`Incorrect complete flag: ${rootName}/${outerName}/${variantName}`);
      }
      if (variant.complete) completeVariantCount++;

      for (const [field, filePath] of Object.entries(variant.files)) {
        const expectedSuffix = { atlas: '.atlas.txt', png: '.png', skel: '.skel.bytes' }[field];
        if (!expectedSuffix || !filePath.endsWith(expectedSuffix)) {
          errors.push(`Invalid ${field} path: ${filePath}`);
        }
        if (!localPaths.has(filePath) && !remotePaths.has(filePath)) {
          errors.push(`Indexed path does not exist locally or in the base commit: ${filePath}`);
        }
        referenceCounts.set(filePath, (referenceCounts.get(filePath) || 0) + 1);
      }
    }
  }
}

for (const localPath of localPaths) {
  if (!/\.(?:atlas\.txt|png|skel\.bytes)$/.test(localPath)) {
    errors.push(`Unexpected local file type: ${localPath}`);
  }
  const count = referenceCounts.get(localPath) || 0;
  if (count !== 1) {
    errors.push(`Local file has ${count} index references: ${localPath}`);
  }
}

for (const [filePath, count] of referenceCounts) {
  if (count !== 1) {
    errors.push(`Index path is referenced ${count} times: ${filePath}`);
  }
}

let pngCount = 0;
let atlasCount = 0;
let skeletonCount = 0;
for (const filePath of localFiles) {
  const relativePath = path.relative(repositoryDirectory, filePath).split(path.sep).join('/');
  if (relativePath.endsWith('.png')) {
    pngCount++;
    const header = fs.readFileSync(filePath).subarray(0, 24);
    const signature = header.subarray(0, 8).toString('hex');
    const width = header.length >= 24 ? header.readUInt32BE(16) : 0;
    const height = header.length >= 24 ? header.readUInt32BE(20) : 0;
    if (signature !== '89504e470d0a1a0a' || width === 0 || height === 0) {
      errors.push(`Invalid PNG: ${relativePath}`);
    }
  } else if (relativePath.endsWith('.atlas.txt')) {
    atlasCount++;
    const atlasText = fs.readFileSync(filePath, 'utf8');
    const pageNames = atlasText.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /\.(?:png|jpg|jpeg)$/i.test(line));
    if (pageNames.length === 0) {
      errors.push(`Atlas has no image page: ${relativePath}`);
    }
    for (const pageName of pageNames) {
      const pagePath = `${path.posix.dirname(relativePath)}/${pageName}`;
      if (!localPaths.has(pagePath) && !remotePaths.has(pagePath)) {
        errors.push(`Atlas page is missing: ${relativePath} -> ${pageName}`);
      }
    }
  } else if (relativePath.endsWith('.skel.bytes')) {
    skeletonCount++;
    if (fs.statSync(filePath).size < 16) {
      errors.push(`Skeleton is unexpectedly small: ${relativePath}`);
    }
  }
}

for (const [outerName, variants] of Object.entries(data.confession || {})) {
  for (const [variantName, variant] of Object.entries(variants)) {
    if (!variant.complete) {
      errors.push(`Incomplete confession variant: ${outerName}/${variantName}`);
    }
  }
}

const summary = {
  roots: Object.fromEntries(Object.entries(data).map(([name, value]) => [name, Object.keys(value).length])),
  variants: variantCount,
  completeVariants: completeVariantCount,
  localFiles: localPaths.size,
  atlasFiles: atlasCount,
  pngFiles: pngCount,
  skeletonFiles: skeletonCount,
  errors: errors.length,
};
console.log(JSON.stringify(summary, null, 2));

if (errors.length > 0) {
  console.error(errors.slice(0, 100).join('\n'));
  process.exitCode = 1;
}
