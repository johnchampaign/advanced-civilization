import sharp from 'sharp';

const civs = ['africa', 'asia', 'assyria', 'babylon', 'crete', 'egypt', 'iberia', 'illyria', 'indus', 'persia', 'thrace'];
const W = 2600, H = 80, gap = 10;
// Crop the right 42% of each strip (where the Late Iron Age numbers sit).
const cropW = Math.round(W * 0.42);
const rows = [];
for (const c of civs) {
  const full = await sharp(`assets/aststrips/images/ASTstrip-${c}.svg`, { density: 260 }).resize(W, H, { fit: 'fill' }).png().toBuffer();
  const right = await sharp(full).extract({ left: W - cropW, top: 0, width: cropW, height: H }).png().toBuffer();
  rows.push({ input: right, top: rows.length * (H + gap) + 4, left: 150 });
}
const labelsSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="${civs.length * (H + gap)}">
  <rect width="100%" height="100%" fill="#222"/>
  ${civs.map((c, i) => `<text x="6" y="${i * (H + gap) + H / 2 + 8}" font-size="26" font-family="sans-serif" fill="#fff" font-weight="bold">${c}</text>`).join('')}
</svg>`;
const totalH = civs.length * (H + gap) + 8;
await sharp({ create: { width: cropW + 150, height: totalH, channels: 3, background: '#222' } })
  .composite([{ input: Buffer.from(labelsSvg), top: 0, left: 0 }, ...rows])
  .png().toFile('assets/ast_strips_right.png');
console.log('wrote', cropW + 150, totalH);
