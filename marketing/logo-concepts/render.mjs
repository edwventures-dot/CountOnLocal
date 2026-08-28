import sharp from 'sharp';
import { readFileSync } from 'fs';
const dir = 'C:/Trey/Claude/CountOnLocal/marketing/logo-concepts';
for (const m of ['m1', 'm2', 'm3']) {
  const buf = readFileSync(`${dir}/${m}.svg`);
  await sharp(buf, { density: 300 }).resize(360, 360).png().toFile(`${dir}/${m}-360.png`);
  // 16px favicon test, upscaled nearest so we can actually see how it holds up
  await sharp(buf, { density: 72 }).resize(16, 16).resize(160, 160, { kernel: 'nearest' }).png().toFile(`${dir}/${m}-16.png`);
  console.log(m, 'ok');
}
