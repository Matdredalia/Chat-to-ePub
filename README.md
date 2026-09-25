# Chat to EPUB (SillyTavern extension)

Export the chat you have open as an EPUB for your Kindle or e-reader, straight from SillyTavern. It runs entirely in the browser — no server plugin, Python or Calibre needed.

**Alpha.** Working title.

## Use

Open a chat, then wand menu → **Export to EPUB**. Fill in:

- **Title, author, language, description** — written into the EPUB's metadata.
- **Cover** — pick a JPEG or PNG. It's embedded in the file, so it shows on the device.
- **Chapters** — start a new chapter every N messages (0 = one chapter).
- **Speaker names**, and whether to repeat them on every message.
- **System / narrator notices** — off by default.

Your browser downloads the `.epub`. Author, language and the toggles are remembered for next time.

## What carries over

Markdown (`*italics*`, `**bold**`, quotes, lists, tables, code) is rendered with SillyTavern's own Markdown settings. Straight quotes become curly, `--` becomes an em dash, `...` becomes an ellipsis. Messages hidden from the AI (`/hide`) are still part of the story and are included. Hidden reasoning (`<think>` blocks) is stripped. Only the swipe you selected is used. Images inside messages are not included.

## Install

Copy this folder into `SillyTavern/data/<your-user>/extensions/chat-to-epub/` and reload SillyTavern.

## Development

The core (`epub.js`, `xhtml.js`, `zip.js`) has no DOM or dependencies and is tested in Node against real chats:

```
node test/build-test.mjs <chat.jsonl> out.epub [cover.png] [chapterEvery]
python3 test/validate.py out.epub
```

The harness expects SillyTavern's `node_modules` (for `showdown`) at `~/OneDrive/Desktop/SillyTavern`; set `ST_ROOT` to change that.

## License

[WTFPL](LICENSE) — do what the fuck you want to.
