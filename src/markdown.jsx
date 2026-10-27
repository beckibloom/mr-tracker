// A small Markdown renderer for notes files: headings, paragraphs, lists, tables, `code`,
// **bold** and [links](https://…). Builds React elements, so file contents are never parsed as HTML.

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

function inline(text, keyPrefix) {
  return text.split(INLINE).map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      return /^https?:\/\//.test(link[2]) ? (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      ) : (
        <span key={key}>{link[1]}</span>
      );
    }
    return part;
  });
}

const cells = (row) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

export function Markdown({ text }) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;
    const heading = line.match(/^(#{1,3})\s+(.*)/);
    if (heading) {
      const Tag = heading[1].length === 1 ? 'h3' : 'h4';
      blocks.push(<Tag key={key}>{inline(heading[2], key)}</Tag>);
      i += 1;
    } else if (line.trim().startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
      const [head, , ...body] = rows;
      blocks.push(
        <table key={key}>
          <thead>
            <tr>
              {cells(head).map((c, j) => (
                <th key={j}>{inline(c, `${key}h${j}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, k) => (
              <tr key={k}>
                {cells(r).map((c, j) => (
                  <td key={j}>{inline(c, `${key}r${k}c${j}`)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
    } else if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      }
      blocks.push(
        <ul key={key}>
          {items.map((it, k) => (
            <li key={k}>{inline(it, `${key}l${k}`)}</li>
          ))}
        </ul>,
      );
    } else if (line.trim()) {
      const para = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,3}\s|\s*\||\s*[-*]\s)/.test(lines[i])
      ) {
        para.push(lines[i++].trim());
      }
      blocks.push(<p key={key}>{inline(para.join(' '), key)}</p>);
    } else {
      i += 1;
    }
  }
  return <div className="md">{blocks}</div>;
}
