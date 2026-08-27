const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const parentDirectory = path.resolve(__dirname, '..');
const defaultRepository = fs.existsSync(path.join(parentDirectory, 'data.json'))
  ? parentDirectory
  : path.join(__dirname, 'langrisser-spiner-db-pr');
const repositoryDirectory = path.resolve(process.argv[2] || defaultRepository);
const dataPath = path.join(repositoryDirectory, 'data.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const baseData = JSON.parse(childProcess.execFileSync(
  'git',
  ['-C', repositoryDirectory, 'show', 'HEAD:data.json'],
  { encoding: 'utf8' },
));
const remotePaths = new Set(childProcess.execFileSync(
  'git',
  ['-C', repositoryDirectory, 'ls-tree', '-r', '--name-only', 'HEAD'],
  { encoding: 'utf8' },
).split(/\r?\n/).filter(Boolean));

function normalizeName(value) {
  return value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function listFilesRecursively(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursively(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseAssetFileName(fileName) {
  const suffixes = [
    ['.atlas.txt', 'atlas'],
    ['.skel.bytes', 'skel'],
    ['.png', 'png'],
  ];

  for (const [suffix, field] of suffixes) {
    if (fileName.endsWith(suffix)) {
      return { baseName: fileName.slice(0, -suffix.length), field };
    }
  }
  return null;
}

function buildFolderMap(rootName) {
  const result = new Map();
  for (const [outerName, variants] of Object.entries(data[rootName] || {})) {
    for (const variant of Object.values(variants)) {
      for (const filePath of Object.values(variant.files)) {
        const parts = filePath.split('/');
        if (parts[0] !== rootName || parts.length < 3) {
          continue;
        }
        const folder = parts[1];
        const previous = result.get(folder);
        if (previous && previous !== outerName) {
          throw new Error(`Folder ${rootName}/${folder} is assigned to both ${previous} and ${outerName}`);
        }
        result.set(folder, outerName);
      }
    }
  }
  return result;
}

function deriveCharOuterName(folder, baseNames) {
  const folderStem = folder.replace(/_abs$/, '');
  if (folderStem.startsWith('npc_')) {
    return `Npc_${folderStem.slice('npc_'.length)}`;
  }

  const target = normalizeName(folderStem);
  const exactMatches = baseNames.filter((baseName) => normalizeName(baseName) === target);
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const suffixMatches = baseNames.filter((baseName) =>
    normalizeName(baseName.replace(/_S$/, '')) === target,
  );
  if (suffixMatches.length === 1) {
    return suffixMatches[0].replace(/_S$/, '');
  }

  throw new Error(`Could not derive an outer character name for ${folder}: ${baseNames.join(', ')}`);
}

function addExtractedRoot(rootName) {
  const rootDirectory = path.join(repositoryDirectory, rootName);
  if (!fs.existsSync(rootDirectory)) {
    return { files: 0, variants: 0 };
  }

  data[rootName] ||= {};
  const folderMap = buildFolderMap(rootName);
  let fileCount = 0;
  const touchedVariants = new Set();

  for (const folder of fs.readdirSync(rootDirectory).sort()) {
    const folderDirectory = path.join(rootDirectory, folder);
    if (!fs.statSync(folderDirectory).isDirectory()) {
      continue;
    }

    const parsedFiles = listFilesRecursively(folderDirectory)
      .map((fullPath) => ({ fullPath, parsed: parseAssetFileName(path.basename(fullPath)) }))
      .filter((item) => item.parsed !== null);
    const baseNames = [...new Set(parsedFiles.map((item) => item.parsed.baseName))].sort();

    let outerName = folderMap.get(folder);
    if (!outerName && rootName === 'confession') {
      const confessionNames = baseNames
        .filter((baseName) => baseName.endsWith('_Confession'))
        .map((baseName) => baseName.slice(0, -'_Confession'.length));
      const uniqueNames = [...new Set(confessionNames)];
      if (uniqueNames.length !== 1) {
        throw new Error(`Could not derive a confession name for ${folder}: ${baseNames.join(', ')}`);
      }
      outerName = uniqueNames[0];
    } else if (!outerName) {
      outerName = deriveCharOuterName(folder, baseNames);
    }

    data[rootName][outerName] ||= {};
    for (const { fullPath, parsed } of parsedFiles) {
      const relativePath = path.relative(repositoryDirectory, fullPath).split(path.sep).join('/');
      const variant = (data[rootName][outerName][parsed.baseName] ||= {
        complete: false,
        files: {},
      });
      const existingPath = variant.files[parsed.field];
      if (existingPath && existingPath !== relativePath) {
        throw new Error(
          `Conflicting ${parsed.field} paths for ${rootName}/${outerName}/${parsed.baseName}: ` +
          `${existingPath} and ${relativePath}`,
        );
      }
      variant.files[parsed.field] = relativePath;
      variant.complete = ['atlas', 'png', 'skel'].every((field) => field in variant.files);
      touchedVariants.add(`${rootName}/${outerName}/${parsed.baseName}`);
      fileCount++;
    }
  }

  return { files: fileCount, variants: touchedVariants.size };
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([left], [right]) => {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }));
}

const charSummary = addExtractedRoot('char');
const confessionSummary = addExtractedRoot('confession');

const availablePaths = new Set(remotePaths);
for (const rootName of ['char', 'char01', 'confession']) {
  for (const fullPath of listFilesRecursively(path.join(repositoryDirectory, rootName))) {
    availablePaths.add(path.relative(repositoryDirectory, fullPath).split(path.sep).join('/'));
  }
}

const resolutionSummary = {
  correctedPaths: 0,
  addedCompanions: 0,
  removedMalformedVariants: 0,
  unresolvedPaths: [],
};

for (const [rootName, outers] of Object.entries(data)) {
  for (const [outerName, variants] of Object.entries(outers)) {
    for (const [variantName, variant] of Object.entries(variants)) {
      const baseVariant = baseData[rootName]?.[outerName]?.[variantName];
      const hasMalformedBasePath = baseVariant && Object.values(baseVariant.files)
        .some((filePath) => !availablePaths.has(filePath));
      if (baseVariant && !hasMalformedBasePath) {
        continue;
      }

      const canonicalVariantName = variantName
        .replace(/\.skel\s*\.bytes$/i, '')
        .replace(/\.atlas(?:\.txt)?$/i, '')
        .replace(/\.png$/i, '');
      if (
        baseVariant &&
        hasMalformedBasePath &&
        canonicalVariantName !== variantName &&
        variants[canonicalVariantName]
      ) {
        delete variants[variantName];
        resolutionSummary.removedMalformedVariants++;
        continue;
      }

      const samplePath = Object.values(variant.files)[0];
      if (!samplePath) {
        continue;
      }

      const sampleParts = samplePath.split('/');
      const scope = sampleParts.slice(0, 2).join('/');
      const normalizedVariantName = normalizeName(variantName);
      const candidatesByField = { atlas: [], png: [], skel: [] };
      for (const candidatePath of availablePaths) {
        if (!candidatePath.startsWith(`${scope}/`)) {
          continue;
        }
        const parsed = parseAssetFileName(path.posix.basename(candidatePath));
        if (parsed && normalizeName(parsed.baseName) === normalizedVariantName) {
          candidatesByField[parsed.field].push(candidatePath);
        }
      }

      for (const [field, suffix] of Object.entries({
        atlas: '.atlas.txt',
        png: '.png',
        skel: '.skel.bytes',
      })) {
        const currentPath = variant.files[field];
        if (currentPath && availablePaths.has(currentPath)) {
          continue;
        }

        const candidates = candidatesByField[field].sort((left, right) => {
          const expectedName = `${variantName}${suffix}`;
          const leftName = path.posix.basename(left);
          const rightName = path.posix.basename(right);
          const leftRank = leftName === expectedName ? 0 : leftName.toLowerCase() === expectedName.toLowerCase() ? 1 : 2;
          const rightRank = rightName === expectedName ? 0 : rightName.toLowerCase() === expectedName.toLowerCase() ? 1 : 2;
          if (leftRank !== rightRank) return leftRank - rightRank;
          const leftDepth = left.split('/').length;
          const rightDepth = right.split('/').length;
          if (leftDepth !== rightDepth) return leftDepth - rightDepth;
          return left < right ? -1 : left > right ? 1 : 0;
        });

        if (candidates.length > 0) {
          variant.files[field] = candidates[0];
          if (currentPath) {
            resolutionSummary.correctedPaths++;
          } else {
            resolutionSummary.addedCompanions++;
          }
        } else if (currentPath) {
          resolutionSummary.unresolvedPaths.push(currentPath);
        }
      }
    }
  }
}

const orderedData = {};
for (const rootName of ['char', 'char01', 'confession']) {
  if (!(rootName in data)) {
    continue;
  }
  orderedData[rootName] = {};
  for (const [outerName, variants] of Object.entries(sortObject(data[rootName]))) {
    orderedData[rootName][outerName] = {};
    for (const [variantName, variant] of Object.entries(sortObject(variants))) {
      const orderedFiles = {};
      for (const field of ['atlas', 'png', 'skel']) {
        if (field in variant.files) {
          orderedFiles[field] = variant.files[field];
        }
      }
      orderedData[rootName][outerName][variantName] = {
        complete: ['atlas', 'png', 'skel'].every((field) => field in orderedFiles),
        files: orderedFiles,
      };
    }
  }
}

const escapedJson = JSON.stringify(orderedData, null, 2).replaceAll(
  '&',
  `${String.fromCharCode(92)}u0026`,
);
fs.writeFileSync(dataPath, escapedJson, 'utf8');

console.log(JSON.stringify({
  char: charSummary,
  confession: confessionSummary,
  pathResolution: resolutionSummary,
}, null, 2));
