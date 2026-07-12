import esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function build() {
	await esbuild.build({
		entryPoints: [path.join(__dirname, 'src', 'admin-app.jsx')],
		bundle: true,
		minify: true,
		sourcemap: false,
		target: ['es2019'],
		format: 'iife',
		platform: 'browser',
		outfile: path.join(__dirname, '..', 'views', 'admin.bundle.js')
	});
	console.log('Built views/admin.bundle.js');
}

build().catch((err) => {
	console.error(err);
	process.exit(1);
});
