import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import postcss from 'esbuild-postcss';


const banner = `/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
`;

const prod = process.argv[2] === "production";



const context = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: {
		main: "plugin/index.ts",
		styles: "plugin/styles.css",
	},
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		"sharp",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outdir: ".", // Output to the root directory
	plugins: [
		postcss({
			plugins: ['tailwindcss', 'autoprefixer'],
			inject: false,
			extract: true,
		}),
	],
	define: prod ? {
		'process.env.NODE_ENV': '"production"'
	} : {},
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
