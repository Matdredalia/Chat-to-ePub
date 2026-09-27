# Chat to EPUB (SillyTavern extension)

Export the chat you have open as an EPUB for your Kindle or e-reader, straight from SillyTavern. It runs entirely in the browser — no server plugin, Python or Calibre needed.

**Alpha.** Working title.

## Use

Open a chat, then wand menu → **Export to EPUB**. Fill in:

- **Title, author, language, description** — written into the EPUB's metadata.
- **Series and book number** — groups the books of one RP together in Calibre and on Kindle. It's remembered per character, and the next book number is filled in for you.
- **Cover** — pick a JPEG or PNG. It's embedded in the file, so it shows on the device.
- **Chapters** — start a new chapter every N messages (0 = one chapter).
- **Message range** — export just messages #N to #M (the numbers ST shows when User Settings → “Message IDs” is on), so a long chat can be cut into books at scene breaks without touching the chat. The next export of the same chat starts where the last range ended.
- **Speaker names**, and whether to repeat them on every message.
- **System / narrator notices** — off by default. This includes TunnelVision summary markers and tool-call notices, so they stay out of the book unless you turn this on.

Your browser downloads the `.epub`. Author, language and the toggles are remembered for next time.

## What carries over

Markdown (`*italics*`, `**bold**`, quotes, lists, tables, code) is rendered with SillyTavern's own Markdown settings. Straight quotes become curly, `--` becomes an em dash, `...` becomes an ellipsis. Messages hidden from the AI (`/hide`) are still part of the story and are included. Hidden reasoning (`<think>` blocks) is stripped. Only the swipe you selected is used. Images inside messages are not included.

## Install

Copy this folder into `SillyTavern/data/<your-user>/extensions/chat-to-epub/` and reload SillyTavern.


## License

[WTFPL](LICENSE) — do what the fuck you want to.
