import {
  App,
  FileSystemAdapter,
  Platform,
  TFile,
  parseLinktext,
  resolveSubpath,
} from 'obsidian';

import { BakeSettings } from './main';
import {
  applyIndent,
  extractSubpath,
  sanitizeBakedContent,
  stripFirstBullet,
} from './util';

const lineStartRE = /(?:^|\n) *$/;
const listLineStartRE = /(?:^|\n)([ \t]*)(?:[-*+]|[0-9]+[.)]) +$/;
const lineEndRE = /^ *(?:\r?\n|$)/;

export async function bake(
  app: App,
  file: TFile,
  subpath: string | null,
  ancestors: Set<TFile>,
  settings: BakeSettings
) {
  const { vault, metadataCache } = app;

  let text = await vault.cachedRead(file);
  const cache = metadataCache.getFileCache(file);

  // Track hidden regions if bakeHidden is disabled
  let hiddenRegions: { start: number; end: number }[] = [];
  if (!settings.bakeHidden) {
    const hiddenStartRE = /%%hidden%%/g;
    const hiddenEndRE = /%%\/hidden%%/g;
    let match;

    // Find all hidden regions
    while ((match = hiddenStartRE.exec(text)) !== null) {
      const start = match.index;
      hiddenEndRE.lastIndex = start + 10; // Length of %%hidden%%
      const endMatch = hiddenEndRE.exec(text);
      if (endMatch) {
        hiddenRegions.push({ start, end: endMatch.index + 12 }); // Length of %%/hidden%%
      }
    }

    // Remove hidden content
    for (let i = hiddenRegions.length - 1; i >= 0; i--) {
      const region = hiddenRegions[i];
      text = text.substring(0, region.start) + text.substring(region.end);
    }
  }

  // No cache? Return the file as is...
  if (!cache) return text;

  // Get the target block or section if we have a subpath
  const resolvedSubpath = subpath ? resolveSubpath(cache, subpath) : null;
  if (resolvedSubpath) {
    text = extractSubpath(text, resolvedSubpath, cache);
  }

  const links = settings.bakeLinks ? cache.links || [] : [];
  const embeds = settings.bakeEmbeds ? cache.embeds || [] : [];
  const targets = [...links, ...embeds];

  // No links in the current file; we can stop here...
  if (targets.length === 0) return text;

  targets.sort((a, b) => a.position.start.offset - b.position.start.offset);

  const newAncestors = new Set(ancestors);
  newAncestors.add(file);

  // This helps us keep track of edits we made to the text and sync them with
  // position data held in the metadata cache
  let posOffset = 0;
  for (const target of targets) {
    // Adjust target position based on hidden content removal
    let adjustedStart = target.position.start.offset;
    let adjustedEnd = target.position.end.offset;

    if (!settings.bakeHidden) {
      let offset = 0;
      for (const region of hiddenRegions) {
        if (region.start < adjustedStart) {
          offset += region.end - region.start;
        } else {
          break;
        }
      }
      adjustedStart -= offset;
      adjustedEnd -= offset;

      // Skip if the link is within a hidden region
      if (
        hiddenRegions.some(
          (region) =>
            target.position.start.offset >= region.start &&
            target.position.end.offset <= region.end
        )
      ) {
        continue;
      }
    }

    const start = adjustedStart + posOffset;
    const end = adjustedEnd + posOffset;
    const prevLen = end - start;

    const before = text.substring(0, start);
    const after = text.substring(end);

    const { path, subpath } = parseLinktext(target.link);
    const linkedFile = metadataCache.getFirstLinkpathDest(path, file.path);

    if (!linkedFile) continue;

    const listMatch = settings.bakeInList
      ? before.match(listLineStartRE)
      : null;
    const isInline =
      !(listMatch || lineStartRE.test(before)) || !lineEndRE.test(after);
    const isMarkdownFile = linkedFile.extension === 'md';

    const replaceTarget = (replacement: string) => {
      text = before + replacement + after;
      posOffset += replacement.length - prevLen;
    };

    if (!isMarkdownFile) {
      // Skip link processing if we're not converting file links...
      if (!settings.convertFileLinks) continue;

      const adapter = app.vault.adapter as FileSystemAdapter;

      // FYI: The mobile adapter also has getFullPath so this should work on mobile and desktop
      //      The mobile adapter isn't exported in the public API, however
      if (!adapter.getFullPath) continue;
      const fullPath = adapter.getFullPath(linkedFile.path);
      const protocol = Platform.isWin ? 'file:///' : 'file://';
      replaceTarget(`![](${protocol}${encodeURI(fullPath)})`);
      continue;
    }

    // Replace the link with its text if the it's inline or would create an infinite loop
    if (newAncestors.has(linkedFile) || isInline) {
      replaceTarget(target.displayText || path);
      continue;
    }

    // Recurse and bake the linked file...
    const baked = sanitizeBakedContent(
      await bake(app, linkedFile, subpath, newAncestors, settings)
    );
    replaceTarget(
      listMatch ? applyIndent(stripFirstBullet(baked), listMatch[1]) : baked
    );
  }

  return text;
}
