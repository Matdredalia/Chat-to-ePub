// Turns the HTML that a Markdown renderer produces (plus whatever raw HTML the
// user typed into a chat) into well-formed XHTML that e-readers will accept.
//
// It is a whitelist sanitizer, not a browser: unknown tags are dropped but their
// text is kept, attributes are dropped except a safe `href`, and every tag is
// closed. Pure string code, so it behaves identically in Node and the browser.

const VOID = new Set(['br', 'hr']);
const INLINE = new Set(['em', 'strong', 'u', 's', 'sub', 'sup', 'small', 'span', 'code', 'a']);

// tag -> output tag
const ALLOWED = {
    p: 'p', br: 'br', hr: 'hr',
    em: 'em', i: 'em', strong: 'strong', b: 'strong', u: 'u', s: 's', del: 's', strike: 's', ins: 'u',
    sub: 'sub', sup: 'sup', small: 'small', mark: 'span', span: 'span',
    blockquote: 'blockquote', pre: 'pre', code: 'code',
    ul: 'ul', ol: 'ol', li: 'li',
    h1: 'h3', h2: 'h3', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6', // h1/h2 are reserved for book structure
    a: 'a',
    table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td',
    div: 'div', center: 'div', details: 'div', summary: 'p',
};

// Opening one of these closes an open <p> (HTML would do the same implicitly).
const CLOSES_P = new Set(['p', 'ul', 'ol', 'blockquote', 'pre', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'div']);

const NAMED_ENTITIES = {
    nbsp: 160, copy: 169, reg: 174, trade: 8482, hellip: 8230, mdash: 8212, ndash: 8211,
    lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, laquo: 171, raquo: 187, bull: 8226,
    middot: 183, deg: 176, times: 215, hearts: 9829, larr: 8592, rarr: 8594, eacute: 233,
    egrave: 232, agrave: 224, aacute: 225, ccedil: 231, uuml: 252, ouml: 246, auml: 228,
    szlig: 223, ntilde: 241, iexcl: 161, iquest: 191, sect: 167, para: 182, dagger: 8224,
};

// Characters XML 1.0 forbids outright (a single one makes the whole file invalid).
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeXml(text) {
    return String(text)
        .replace(XML_ILLEGAL, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Escape text-node content, keeping valid entities and converting HTML-only named ones to numeric. */
function escapeText(text) {
    return text
        .replace(XML_ILLEGAL, '')
        .replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);|&/g, (match, name) => {
            if (!name) return '&amp;';
            if (name[0] === '#' || ['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return match;
            return name in NAMED_ENTITIES ? `&#${NAMED_ENTITIES[name]};` : `&amp;${name};`;
        })
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function safeHref(attrs) {
    const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const href = (m && (m[1] ?? m[2] ?? m[3]) || '').trim();
    return /^(https?:|mailto:)/i.test(href) ? href : null;
}

// Apostrophe-first contractions that should get a closing curl (’em, ’til, ’cause…).
const ELISION_RE = /^(em|til|till|cause|cuz|round|bout|tis|twas|twere|kay|sup|n)\b/i;

/**
 * Typographic quotes, ellipses and dashes for one text node.
 * @param {string} text   plain text (entities already decoded for quotes)
 * @param {string} prev   the character that came right before this node
 */
function smarten(text, prev) {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const before = i === 0 ? prev : text[i - 1];
        const opensHere = !before || /[\s([{\u2014\u2013\u201C\u2018]/.test(before);
        if (ch === '"') {
            out += opensHere ? '\u201C' : '\u201D';
        } else if (ch === "'") {
            const rest = text.slice(i + 1);
            const elision = opensHere && (/^\d/.test(rest) || ELISION_RE.test(rest));
            out += opensHere && !elision ? '\u2018' : '\u2019';
        } else if (ch === '-' && text[i + 1] === '-' && text[i + 2] !== '-') {
            out += '\u2014';
            i++;
        } else if (ch === '.' && text[i + 1] === '.' && text[i + 2] === '.') {
            out += '\u2026';
            i += 2;
        } else {
            out += ch;
        }
    }
    return out;
}

const TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

/**
 * @param {string} html
 * @param {{smart?: boolean}} [options]  smart: curly quotes / dashes / ellipses (default true)
 * @returns {string} XHTML fragment
 */
export function htmlToXhtml(html, { smart = true } = {}) {
    const out = [];
    const stack = []; // output tag names currently open
    let last = 0;
    let prev = ''; // last text character emitted, so quotes know if they open or close

    const emitText = (raw) => {
        let text = raw;
        if (smart && !stack.includes('pre') && !stack.includes('code')) {
            text = smarten(text.replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'"), prev);
        }
        if (text) prev = text.replace(/&[^;\s]+;$/, 'x').slice(-1) || prev;
        out.push(escapeText(text));
    };

    const close = (tag) => out.push(`</${tag}>`);
    const closeUntil = (tag) => {
        if (!stack.includes(tag)) return false;
        while (stack.length) {
            const top = stack.pop();
            close(top);
            if (top === tag) break;
        }
        return true;
    };

    // Drop script/style blocks including their contents.
    html = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');

    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(html))) {
        if (m.index > last) emitText(html.slice(last, m.index));
        last = TAG_RE.lastIndex;
        if (!m[1]) continue; // comment

        const src = m[1].toLowerCase();
        const isClosing = m[0][1] === '/';
        const tag = ALLOWED[src];
        if (!tag) continue; // unknown tag: drop it, keep its text

        if (!INLINE.has(tag)) prev = '';
        if (isClosing) {
            if (!VOID.has(tag)) closeUntil(tag);
            continue;
        }

        if (VOID.has(tag)) {
            out.push(`<${tag}/>`);
            continue;
        }

        if (CLOSES_P.has(tag) && stack[stack.length - 1] === 'p') close(stack.pop());
        if (tag === 'li' && stack[stack.length - 1] === 'li') close(stack.pop());

        let open = `<${tag}`;
        if (tag === 'a') {
            const href = safeHref(m[2]);
            if (href) open += ` href="${escapeXml(href)}"`;
        }
        out.push(`${open}>`);
        stack.push(tag);

        if (m[0].endsWith('/>')) closeUntil(tag); // self-closed non-void tag, e.g. <p/>
    }
    if (last < html.length) emitText(html.slice(last));
    while (stack.length) close(stack.pop());
    return out.join('');
}
