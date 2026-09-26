// Chat to EPUB — export the open SillyTavern chat as an EPUB for e-readers.
// Everything runs in the browser: no server plugin, Python or Calibre needed.

import { buildEpub, detectCover, isRealSystemMessage } from './epub.js';

const PREFS_KEY = 'chat_to_epub_prefs';
const MAX_COVER_BYTES = 10 * 1024 * 1024;

let coverFile = null; // { name, bytes: Uint8Array, url }

// ─────────────────────────── helpers ───────────────────────────

function getCtx() {
    return typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
}

function notify(kind, message) {
    if (typeof toastr !== 'undefined') toastr[kind](message, 'Chat to EPUB');
    else console[kind === 'error' ? 'error' : 'log']('[Chat to EPUB]', message);
}

function loadPrefs() {
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
        return {};
    }
}

function savePrefs(prefs) {
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* storage unavailable: fine, prefs are a convenience */ }
}

function makeConverter() {
    const showdown = (SillyTavern.libs && SillyTavern.libs.showdown) || window.showdown;
    if (!showdown) throw new Error('SillyTavern did not expose its Markdown library (SillyTavern.libs.showdown).');
    // Same options SillyTavern's own message renderer uses.
    const converter = new showdown.Converter({
        emoji: true,
        literalMidWordUnderscores: true,
        parseImgDimensions: true,
        tables: true,
        underline: true,
        simpleLineBreaks: true,
        strikethrough: true,
        disableForced4SpacesIndentedSublists: true,
    });
    return (text) => converter.makeHtml(text);
}

/** Title and names for whatever is open: a character chat or a group chat. */
function describeChat(ctx) {
    const userName = ctx.name1 || 'You';
    let charName = ctx.name2 || 'Character';
    if (ctx.groupId && Array.isArray(ctx.groups)) {
        const group = ctx.groups.find((g) => String(g.id) === String(ctx.groupId));
        if (group && group.name) charName = group.name;
    }
    return { userName, charName, hasChat: !!(ctx.groupId || ctx.characterId !== undefined) };
}

/** Copy messages, resolving the common {{user}}/{{char}} macros the way ST would show them. */
function prepareMessages(ctx, userName, charName) {
    const fill = (text) => String(text ?? '').replace(/\{\{user\}\}/gi, userName).replace(/\{\{char\}\}/gi, charName);
    return (ctx.chat || []).map((m) => ({ ...m, mes: fill(m.mes) }));
}

/** Read the From/To fields into an inclusive 0-based range over the chat array. */
function readRange(length) {
    const parse = (id) => {
        const raw = $(id).value.trim();
        if (raw === '') return null;
        const n = Number(raw);
        return Number.isInteger(n) && n >= 0 ? n : NaN;
    };
    const fromRaw = parse('cte-from');
    const toRaw = parse('cte-to');
    if (Number.isNaN(fromRaw) || Number.isNaN(toRaw)) return { error: 'Message numbers must be whole numbers, 0 or higher.' };
    const from = fromRaw ?? 0;
    const to = Math.min(toRaw ?? length - 1, length - 1);
    if (from > length - 1) return { error: `The chat only goes up to #${length - 1}.` };
    if (from > to) return { error: '“From” can’t be after “To”.' };
    return { from, to, explicitTo: toRaw !== null };
}

function currentChatId(ctx) {
    return typeof ctx.getCurrentChatId === 'function' ? ctx.getCurrentChatId() : ctx.chatId;
}

function safeFileName(title) {
    const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    return cleaned || 'chat';
}

function download(bytes, fileName) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/epub+zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ─────────────────────────── dialog ───────────────────────────

function dialogTemplate() {
    return `
    <div class="cte-dialog" role="dialog" aria-modal="true" aria-labelledby="cte-heading">
        <h3 id="cte-heading">Export chat as EPUB</h3>
        <p class="cte-sub" id="cte-sub"></p>

        <div class="cte-field">
            <label for="cte-title">Title</label>
            <input type="text" class="text_pole" id="cte-title" />
        </div>
        <div class="cte-row">
            <div class="cte-field">
                <label for="cte-author">Author</label>
                <input type="text" class="text_pole" id="cte-author" />
            </div>
            <div class="cte-field" style="max-width: 110px;">
                <label for="cte-language">Language</label>
                <input type="text" class="text_pole" id="cte-language" placeholder="en" />
            </div>
        </div>
        <div class="cte-row">
            <div class="cte-field">
                <label for="cte-series">Series <span style="opacity:.6">(optional — groups books in Calibre / Kindle)</span></label>
                <input type="text" class="text_pole" id="cte-series" placeholder="e.g. the name of this RP" />
            </div>
            <div class="cte-field" style="max-width: 110px;">
                <label for="cte-series-index">Book #</label>
                <input type="number" class="text_pole" id="cte-series-index" min="0" step="any" />
            </div>
        </div>
        <div class="cte-field">
            <label for="cte-description">Description <span style="opacity:.6">(optional)</span></label>
            <textarea class="text_pole" id="cte-description" rows="3"></textarea>
        </div>

        <div class="cte-field">
            <span class="cte-label">Cover</span>
            <div class="cte-cover-row">
                <div class="cte-cover-thumb" id="cte-cover-thumb"></div>
                <div class="cte-cover-meta">
                    <div class="cte-cover-name" id="cte-cover-name">No cover selected</div>
                    <div class="cte-cover-buttons">
                        <button type="button" class="menu_button" id="cte-cover-pick">Choose image…</button>
                        <button type="button" class="menu_button" id="cte-cover-clear" style="display:none">Remove</button>
                    </div>
                </div>
                <input type="file" id="cte-cover-input" style="display:none" />
            </div>
        </div>

        <div class="cte-field">
            <label for="cte-chapter">Start a new chapter every N messages <span style="opacity:.6">(0 = one chapter)</span></label>
            <input type="number" class="text_pole" id="cte-chapter" min="0" step="1" value="0" style="max-width: 120px;" />
        </div>
        <div class="cte-field">
            <span class="cte-label">Message range <span style="opacity:.6">— the <b>#</b> numbers shown on messages (User Settings → “Message IDs”). Blank = whole chat.</span></span>
            <div class="cte-row">
                <div class="cte-field" style="margin-bottom:0">
                    <label for="cte-from">From #</label>
                    <input type="number" class="text_pole" id="cte-from" min="0" step="1" placeholder="start" />
                </div>
                <div class="cte-field" style="margin-bottom:0">
                    <label for="cte-to">To #</label>
                    <input type="number" class="text_pole" id="cte-to" min="0" step="1" placeholder="end" />
                </div>
            </div>
        </div>
        <label class="cte-check"><input type="checkbox" id="cte-names" /> Show speaker names</label>
        <label class="cte-check"><input type="checkbox" id="cte-names-every" /> Repeat the name even when the same person posts twice in a row</label>
        <label class="cte-check"><input type="checkbox" id="cte-system" /> Include system / narrator notices <span style="opacity:.6">(and TunnelVision summaries)</span></label>

        <p class="cte-info" id="cte-info"></p>
        <p class="cte-error" id="cte-error" role="alert"></p>

        <div class="cte-actions">
            <button type="button" class="menu_button" id="cte-cancel">Cancel</button>
            <button type="button" class="menu_button" id="cte-export">Export EPUB</button>
        </div>
    </div>`;
}

const $ = (id) => document.getElementById(id);

function setCover(file) {
    if (coverFile && coverFile.url) URL.revokeObjectURL(coverFile.url);
    coverFile = file;
    $('cte-cover-thumb').style.backgroundImage = file ? `url("${file.url}")` : '';
    $('cte-cover-name').textContent = file ? file.name : 'No cover selected';
    $('cte-cover-clear').style.display = file ? '' : 'none';
}

async function onCoverChosen(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    $('cte-error').textContent = '';
    try {
        if (file.size > MAX_COVER_BYTES) throw new Error('That image is over 10 MB. Try a smaller one (about 1600×2560 is plenty).');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const kind = detectCover(bytes);
        if (!kind) throw new Error('Covers must be JPEG or PNG. WebP and other formats are not supported by Kindle.');
        setCover({ name: file.name, bytes, url: URL.createObjectURL(new Blob([bytes], { type: kind.type })) });
    } catch (e) {
        $('cte-error').textContent = e.message;
    }
}

function refreshInfo() {
    const ctx = getCtx();
    if (!ctx) return;
    const chat = ctx.chat || [];
    const range = readRange(chat.length);
    if (range.error) {
        $('cte-info').textContent = range.error;
        return;
    }
    const includeSystem = $('cte-system').checked;
    const usable = chat.slice(range.from, range.to + 1)
        .filter((m) => String(m.mes ?? '').trim() && (includeSystem || !isRealSystemMessage(m))).length;
    const scope = range.from === 0 && range.to === chat.length - 1 ? 'whole chat' : `messages #${range.from}–#${range.to}`;
    $('cte-info').textContent = `${usable} messages will be included (${scope}; the chat runs #0–#${chat.length - 1}).`;
}

function openDialog() {
    const ctx = getCtx();
    if (!ctx) return notify('error', 'Could not reach SillyTavern.');
    const { userName, charName, hasChat } = describeChat(ctx);
    if (!hasChat || !(ctx.chat || []).length) return notify('warning', 'Open a chat first, then try again.');

    const prefs = loadPrefs();
    $('cte-sub').textContent = `Exporting the chat currently open with ${charName.replace(/_/g, ' ')}.`;
    $('cte-title').value = `${charName} & ${userName}`.replace(/_/g, ' ');
    $('cte-author').value = prefs.author || userName;
    $('cte-language').value = prefs.language || 'en';
    $('cte-description').value = '';
    // The series is remembered per character, with the next book number ready to go.
    const remembered = (prefs.seriesByChar || {})[charName] || {};
    $('cte-series').value = remembered.name || '';
    $('cte-series-index').value = remembered.next ?? '';
    $('cte-chapter').value = prefs.chapterEvery ?? 0;
    // Book 2 of a chat picks up where book 1 ended.
    const next = (prefs.rangeNext || {})[currentChatId(ctx)];
    $('cte-from').value = Number.isInteger(next) && next < ctx.chat.length ? next : '';
    $('cte-to').value = '';
    $('cte-names').checked = prefs.showNames ?? true;
    $('cte-names-every').checked = prefs.nameEveryMessage ?? false;
    $('cte-system').checked = prefs.includeSystem ?? false;
    $('cte-error').textContent = '';
    setCover(null);
    syncNameOptions();
    refreshInfo();

    $('cte-overlay').classList.add('cte-open');
    $('cte-title').focus();
}

// The "repeat" option only means something while names are shown.
function syncNameOptions() {
    const on = $('cte-names').checked;
    $('cte-names-every').disabled = !on;
    $('cte-names-every').parentElement.style.opacity = on ? '' : '0.5';
}

function closeDialog() {
    $('cte-overlay').classList.remove('cte-open');
    setCover(null);
}

async function onExport() {
    const ctx = getCtx();
    const button = $('cte-export');
    $('cte-error').textContent = '';
    try {
        const { userName, charName } = describeChat(ctx);
        const title = $('cte-title').value.trim() || `${charName} & ${userName}`;
        const author = $('cte-author').value.trim() || userName;
        const language = $('cte-language').value.trim() || 'en';
        const series = $('cte-series').value.trim();
        const seriesIndexRaw = $('cte-series-index').value.trim();
        const options = {
            chapterEvery: Math.max(0, Math.floor(Number($('cte-chapter').value) || 0)),
            showNames: $('cte-names').checked,
            nameEveryMessage: $('cte-names-every').checked,
            includeSystem: $('cte-system').checked,
        };

        const range = readRange((ctx.chat || []).length);
        if (range.error) throw new Error(range.error);

        button.disabled = true;
        button.textContent = 'Building…';
        // Let the button repaint before the (synchronous) rendering work starts.
        await new Promise((resolve) => setTimeout(resolve, 30));

        const { bytes, count } = await buildEpub({
            messages: prepareMessages(ctx, userName, charName).slice(range.from, range.to + 1),
            meta: { title, author, language, description: $('cte-description').value.trim(), series, seriesIndex: seriesIndexRaw },
            cover: coverFile ? { bytes: coverFile.bytes } : null,
            options,
            markdownToHtml: makeConverter(),
        });

        download(bytes, `${safeFileName(title)}.epub`);
        const prefs = loadPrefs();
        const seriesByChar = { ...(prefs.seriesByChar || {}) };
        const index = Number(seriesIndexRaw);
        if (series) seriesByChar[charName] = { name: series, next: seriesIndexRaw !== '' && Number.isFinite(index) ? index + 1 : '' };
        else delete seriesByChar[charName];
        // Remember where this book ended so the next one can start right after it.
        const rangeNext = { ...(prefs.rangeNext || {}) };
        const chatKey = currentChatId(ctx);
        if (range.explicitTo && range.to < ctx.chat.length - 1) rangeNext[chatKey] = range.to + 1;
        else delete rangeNext[chatKey];
        savePrefs({ ...prefs, author, language, ...options, seriesByChar, rangeNext });
        notify('success', `Exported ${count} messages.`);
        closeDialog();
    } catch (e) {
        console.error('[Chat to EPUB] Export failed:', e);
        $('cte-error').textContent = `Export failed: ${e.message}`;
    } finally {
        button.disabled = false;
        button.textContent = 'Export EPUB';
    }
}

function injectDialog() {
    if ($('cte-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'cte-overlay';
    overlay.innerHTML = dialogTemplate();
    document.body.appendChild(overlay);

    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) closeDialog();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.classList.contains('cte-open')) closeDialog();
    });
    $('cte-cancel').addEventListener('click', closeDialog);
    $('cte-export').addEventListener('click', onExport);
    $('cte-cover-pick').addEventListener('click', () => $('cte-cover-input').click());
    $('cte-cover-clear').addEventListener('click', () => setCover(null));
    $('cte-cover-input').addEventListener('change', (e) => onCoverChosen(e.target));
    $('cte-names').addEventListener('change', syncNameOptions);
    $('cte-system').addEventListener('change', refreshInfo);
    $('cte-from').addEventListener('input', refreshInfo);
    $('cte-to').addEventListener('input', refreshInfo);
}

function injectMenuButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('cte-menu-button')) return;
    const item = document.createElement('div');
    item.id = 'cte-menu-button';
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = '<div class="fa-solid fa-book extensionsMenuExtensionButton"></div> Export to EPUB';
    item.addEventListener('click', openDialog);
    menu.appendChild(item);
}

jQuery(() => {
    injectDialog();
    injectMenuButton();
});
