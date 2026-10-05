const paths={
 '＋':'<path d="M12 3v18M3 12h18"/>',
 '✓':'<path d="m4 12 5 5L20 6"/>',
 '−':'<path d="M3 12h18"/>',
 '↗':'<path d="M5 19 19 5M5 5h14v14"/>',
 '↔':'<path d="M3 12h18M7 7l-5 5 5 5M17 7l5 5-5 5"/>',
 '↶':'<path d="m8 4-6 6 6 6M3 10h10a8 8 0 0 1 8 8"/>',
 '↺':'<path d="M4 10a8 8 0 1 1 0 5M4 4v6h6"/>',
 '↓':'<path d="M12 3v18M5 14l7 7 7-7"/>',
 '↑':'<path d="M12 21V3M5 10l7-7 7 7"/>',
 '←':'<path d="M21 12H3M10 5l-7 7 7 7"/>',
 '→':'<path d="M3 12h18M14 5l7 7-7 7"/>',
 '♡':'<path d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
 '♥':'<path fill="currentColor" d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
 '✳':'<path fill="currentColor" stroke="none" d="m10 0 4 0 1 7 5-5 3 3-5 5 6 1v4l-7 1 5 5-3 3-5-5-1 7h-4l-1-7-5 5-3-3 5-5-7-1v-4l7-1-5-5 3-3 5 5Z"/>'
};
export function glyph(symbol){return `<svg class="glyph glyph-${symbol==='✳'?'star':symbol==='♡'||symbol==='♥'?'heart':'arrow'}" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" viewBox="${symbol==='✳'?'0 0 26 26':'0 0 24 24'}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter">${paths[symbol]||''}</svg>`;}
export function replaceGlyphs(html){return html.replace(/[↗↔↶↺↓↑←→♡♥✳＋✓−]/g,glyph);}
