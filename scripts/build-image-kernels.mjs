import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', 'image-kernels/Cargo.toml'], { cwd: root, stdio: 'inherit' });
mkdirSync(`${root}/src/utils/wasm`, { recursive: true });
copyFileSync(`${root}/image-kernels/target/wasm32-unknown-unknown/release/darkslide_image_kernels.wasm`, `${root}/src/utils/wasm/image_kernels.wasm`);
