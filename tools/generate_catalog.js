const fs = require('fs');
const path = require('path');

const repositoryDirectory = path.resolve(__dirname, '..');
const dataPath = path.join(repositoryDirectory, 'data.json');
const catalogPath = path.join(repositoryDirectory, 'catalog.json');

const collectionTitles = {
  char: 'Characters',
  char01: 'Characters',
  confession: 'Confessions',
};

function words(value) {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function comparable(value) {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function variantTitle(characterName, variantName) {
  if (comparable(characterName) === comparable(variantName)) {
    return 'Default';
  }

  if (variantName.toLowerCase().startsWith(`${characterName.toLowerCase()}_`)) {
    return words(variantName.slice(characterName.length + 1));
  }

  return words(variantName);
}

function tagsFor(collectionName, characterName, variantName) {
  const tags = [collectionName];
  const searchableText = `${characterName}_${variantName}`;

  for (const tag of searchableText.split(/[_\s&-]+/)) {
    if (tag && !tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
      tags.push(tag.toLowerCase());
    }
  }

  return tags;
}

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const items = [];
const ids = new Set();
let skipped = 0;

for (const [collectionName, characters] of Object.entries(data)) {
  for (const [characterName, variants] of Object.entries(characters)) {
    for (const [variantName, entry] of Object.entries(variants)) {
      const files = entry.files || {};
      if (!entry.complete || !files.skel || !files.atlas || !files.png) {
        skipped += 1;
        continue;
      }

      const id = `${collectionName}/${characterName}/${variantName}`;
      if (ids.has(id)) {
        throw new Error(`Duplicate catalog item id: ${id}`);
      }
      ids.add(id);

      items.push({
        id,
        title: words(characterName),
        variant: variantTitle(characterName, variantName),
        collection: collectionTitles[collectionName] || words(collectionName),
        tags: tagsFor(collectionName, characterName, variantName),
        format: 'skel',
        thumbnail: { url: files.png },
        bundle: {
          skeleton: { url: files.skel, format: 'auto' },
          atlas: { url: files.atlas },
          textures: [{ url: files.png }],
          premultipliedAlpha: 'auto',
        },
      });
    }
  }
}

const manifest = {
  schemaVersion: 1,
  catalog: {
    id: 'langrisser-spine',
    title: 'Langrisser Spine Catalog',
  },
  items,
};

fs.writeFileSync(catalogPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${items.length} items to ${path.relative(process.cwd(), catalogPath)} (${skipped} incomplete entries skipped).`);
