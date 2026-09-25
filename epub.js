// Builds an EPUB 3 (with an EPUB 2 NCX for older readers / Kindle conversion)
// from a list of SillyTavern chat messages. No DOM, no dependencies: the
// Markdown renderer is passed in so this runs in the browser and in Node tests.

import { writeZip } from './zip.js';
import { escapeXml, htmlToXhtml } from './xhtml.js';

const STYLE = `
body { font-family: serif; line-height: 1.45; margin: 0 4%; }
h1.title { text-align: center; margin: 1.5em 0 0.2em; }
p.byline { text-align: center; font-style: italic; margin-bottom: 2em; }
h2 { text-align: center; margin: 1.5em 0 1em; }
div.msg { margin: 0 0 1.1em; }
div.msg p { margin: 0 0 0.6em; text-align: left; }
p.speaker { font-variant: small-caps; font-weight: bold; letter-spacing: 0.04em; margin-bottom: 0.15em; }
div.user { margin-left: 1.2em; padding-left: 0.7em; border-left: 2px solid #888; }
div.system { text-align: center; font-style: italic; color: #555; }
blockquote { margin: 0.5em 1.2em; font-style: italic; }
pre, code { font-family: monospace; font-size: 0.9em; white-space: pre-wrap; }
hr { margin: 1.2em 30%; }
table { border-collapse: collapse; } td, th { border: 1px solid #888; padding: 0.2em 0.5em; }
div.cover { text-align: center; margin: 0; padding: 0; }
div.cover img { max-width: 100%; max-height: 100%; }
`;

// Reasoning / hidden-thought blocks some models emit; not part of the story.
const THINK_RE = /<(think|thinking|thought|reasoning)>[\s\S]*?<\/\1>/gi;

const COVER_TYPES = [
    { type: 'image/jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
    { type: 'image/png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
];

export function detectCover(bytes) {
    return COVER_TYPES.find((t) => t.magic.every((b, i) => bytes[i] === b)) || null;
}

/**
 * ST sets is_system on two very different things: messages hidden from the AI
 * (/hide, context trimming; still real story text) and genuine system/narrator
 * notices. Genuine notices carry an extra.type or are named "System".
 */
export function isRealSystemMessage(msg) {
    return !!msg.is_system && (!!(msg.extra && msg.extra.type) || String(msg.name || '').toLowerCase() === 'system');
}

const prettyName = (name) => String(name).replace(/_/g, ' ');

function randomUuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

function xhtmlPage(title, body) {
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`;
}

/**
 * @param {object} input
 * @param {object[]} input.messages   ST chat messages (header line already removed)
 * @param {object} input.meta         { title, author, language, description }
 * @param {{bytes: Uint8Array}|null} input.cover  jpeg or png bytes
 * @param {object} input.options      { chapterEvery, showNames, nameEveryMessage, includeSystem, userName, charName }
 * @param {(text: string) => string} input.markdownToHtml
 * @returns {Promise<{bytes: Uint8Array, count: number}>}
 */
export async function buildEpub({ messages, meta, cover, options = {}, markdownToHtml }) {
    const {
        chapterEvery = 0,
        showNames = true,
        nameEveryMessage = false,
        includeSystem = false,
    } = options;
    const title = (meta.title || 'Untitled chat').trim();
    const author = (meta.author || 'Unknown').trim();
    const language = (meta.language || 'en').trim();

    // ── render messages ──
    const rendered = [];
    let lastSpeaker = null;
    for (const msg of messages) {
        const raw = String(msg.mes ?? '').trim();
        if (!raw) continue;
        const isSystem = isRealSystemMessage(msg);
        if (isSystem && !includeSystem) continue;

        const text = raw.replace(THINK_RE, '').trim();
        if (!text) continue;
        const body = htmlToXhtml(markdownToHtml(text));
        if (!body.replace(/<[^>]*>/g, '').trim()) continue;

        const name = msg.name || (msg.is_user ? 'You' : 'Character');
        const cls = isSystem ? 'system' : msg.is_user ? 'user' : 'char';
        const label = showNames && !isSystem && (name !== lastSpeaker || nameEveryMessage)
            ? `<p class="speaker">${escapeXml(prettyName(name))}</p>\n`
            : '';
        rendered.push({ html: `<div class="msg ${cls}">\n${label}${body}\n</div>` });
        lastSpeaker = name;
    }
    if (!rendered.length) throw new Error('This chat has no visible messages to export.');

    // ── chapters ──
    const size = chapterEvery > 0 ? chapterEvery : rendered.length;
    const chapters = [];
    for (let i = 0; i < rendered.length; i += size) {
        chapters.push({
            id: `chapter-${chapters.length + 1}`,
            file: `chapter-${chapters.length + 1}.xhtml`,
            title: chapterEvery > 0 ? `Part ${chapters.length + 1}` : title,
            html: rendered.slice(i, i + size).map((r) => r.html).join('\n'),
        });
    }
    // Title and byline sit at the top of the first chapter, so a one-chapter book still reads as a book.
    const front = `<h1 class="title">${escapeXml(title)}</h1>\n<p class="byline">${escapeXml(author)}</p>\n`;
    chapters.forEach((ch, i) => {
        const heading = chapterEvery > 0 ? `<h2>${escapeXml(ch.title)}</h2>\n` : '';
        ch.xhtml = xhtmlPage(ch.title, `${i === 0 ? front : ''}${heading}${ch.html}`);
    });

    // ── package files ──
    const coverInfo = cover ? detectCover(cover.bytes) : null;
    if (cover && !coverInfo) throw new Error('Cover must be a JPEG or PNG image.');
    const uuid = randomUuid();
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

    const manifest = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
        '<item id="css" href="style.css" media-type="text/css"/>',
    ];
    const spine = [];
    if (coverInfo) {
        manifest.push(`<item id="cover-image" href="images/cover.${coverInfo.ext}" media-type="${coverInfo.type}" properties="cover-image"/>`);
        manifest.push('<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>');
        spine.push('<itemref idref="cover-page"/>');
    }
    for (const ch of chapters) {
        manifest.push(`<item id="${ch.id}" href="${ch.file}" media-type="application/xhtml+xml"/>`);
        spine.push(`<itemref idref="${ch.id}"/>`);
    }

    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">urn:uuid:${uuid}</dc:identifier>
<dc:title>${escapeXml(title)}</dc:title>
<dc:creator>${escapeXml(author)}</dc:creator>
<dc:language>${escapeXml(language)}</dc:language>${meta.description ? `\n<dc:description>${escapeXml(meta.description)}</dc:description>` : ''}
<meta property="dcterms:modified">${modified}</meta>${coverInfo ? '\n<meta name="cover" content="cover-image"/>' : ''}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
</package>`;

    const navItems = chapters.map((ch) => `<li><a href="${ch.file}">${escapeXml(ch.title)}</a></li>`).join('\n');
    const nav = xhtmlPage('Contents', `<nav epub:type="toc" id="toc"><h2>Contents</h2>\n<ol>\n${navItems}\n</ol></nav>`);

    const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${uuid}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${chapters.map((ch, i) => `<navPoint id="np-${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(ch.title)}</text></navLabel><content src="${ch.file}"/></navPoint>`).join('\n')}
</navMap>
</ncx>`;

    const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

    const enc = new TextEncoder();
    const files = [
        // The mimetype entry must be first and stored uncompressed.
        { name: 'mimetype', data: enc.encode('application/epub+zip'), compress: false },
        { name: 'META-INF/container.xml', data: enc.encode(container) },
        { name: 'OEBPS/content.opf', data: enc.encode(opf) },
        { name: 'OEBPS/nav.xhtml', data: enc.encode(nav) },
        { name: 'OEBPS/toc.ncx', data: enc.encode(ncx) },
        { name: 'OEBPS/style.css', data: enc.encode(STYLE) },
    ];
    if (coverInfo) {
        files.push({
            name: 'OEBPS/cover.xhtml',
            data: enc.encode(xhtmlPage(title, `<div class="cover"><img src="images/cover.${coverInfo.ext}" alt="Cover"/></div>`)),
        });
        files.push({ name: `OEBPS/images/cover.${coverInfo.ext}`, data: cover.bytes, compress: false });
    }
    for (const ch of chapters) files.push({ name: `OEBPS/${ch.file}`, data: enc.encode(ch.xhtml) });

    return { bytes: await writeZip(files), count: rendered.length };
}
