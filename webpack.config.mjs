import path from "node:path";
import {fileURLToPath} from "node:url";
import {readFileSync} from "node:fs";
import crypto from "node:crypto";
import {promisify} from "node:util";
import zlib from "node:zlib";
import {execSync} from "node:child_process";
import webpack from "webpack";
import CopyPlugin from "copy-webpack-plugin";
import ForkTsCheckerWebpackPlugin from "fork-ts-checker-webpack-plugin";
import MiniCssExtractPlugin from "mini-css-extract-plugin";
import {VueLoaderPlugin} from "vue-loader";
import babelConfig from "./babel.config.cjs";
import postcssConfig from "./postcss.config.js";

const {Compilation, DefinePlugin, NormalModuleReplacementPlugin, sources} = webpack;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const resolveFromRoot = (...segments) => path.resolve(__dirname, ...segments);
const packageJson = JSON.parse(readFileSync(resolveFromRoot("package.json"), "utf8"));

function getVersion() {
	let gitCommit = null;

	try {
		gitCommit = execSync('git --git-dir ".git" rev-parse --short HEAD', {
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
	} catch {
		// Not a git repository or git is not installed
	}

	const version = `v${packageJson.version}`;

	if (gitCommit) {
		return `source (${gitCommit} / ${version})`;
	}

	// Same as server/helper.ts getVersion: Docker builds pass the commit
	const buildCommit = process.env.THELOUNGE_BUILD_COMMIT?.slice(0, 7);
	return buildCommit ? `${version} (${buildCommit})` : version;
}

function getVersionCacheBust() {
	const hash = crypto.createHash("sha256").update(getVersion()).digest("hex");
	return hash.substring(0, 10);
}

// CI type checks in a job of its own (yarn lint:types), so its builds set
// THELOUNGE_SKIP_TYPECHECK and leave this pass out
const skipTypeCheck = Boolean(process.env.THELOUNGE_SKIP_TYPECHECK);

const createForkTsCheckerPlugin = (withBuild) =>
	new ForkTsCheckerWebpackPlugin({
		typescript: {
			diagnosticOptions: {
				semantic: true,
				syntactic: true,
			},
			...(withBuild ? {build: true} : {}),
		},
	});

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// Writes .br and .gz next to each text asset; server/staticAssets.ts serves them
class PrecompressPlugin {
	apply(compiler) {
		compiler.hooks.thisCompilation.tap("PrecompressPlugin", (compilation) => {
			compilation.hooks.processAssets.tapPromise(
				{
					name: "PrecompressPlugin",
					stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER,
				},
				async (assets) => {
					// The dev server serves from memory and never reads these
					if (compiler.watchMode) {
						return;
					}

					const jobs = Object.entries(assets)
						.filter(([name]) => /\.(js|css|svg|ico|webmanifest|json)$/.test(name))
						.map(async ([name, asset]) => {
							const input = asset.buffer();

							if (input.length < 1024) {
								return;
							}

							const [br, gz] = await Promise.all([
								brotli(input, {
									params: {[zlib.constants.BROTLI_PARAM_QUALITY]: 11},
								}),
								gzip(input, {level: 9}),
							]);

							compilation.emitAsset(`${name}.br`, new sources.RawSource(br));
							compilation.emitAsset(`${name}.gz`, new sources.RawSource(gz));
						});

					await Promise.all(jobs);
				}
			);
		});
	}
}

const createMiniCssExtractPlugin = () =>
	new MiniCssExtractPlugin({
		filename: "css/style.css",
		chunkFilename: "css/chunk.[contenthash:8].css",
	});

const copyPatterns = (isProduction) => [
	{
		from: resolveFromRoot("client/fonts/font-awesome/*").replace(/\\/g, "/"),
		to: "fonts/font-awesome/[name][ext]",
	},
	{
		from: resolveFromRoot("client/js/loading-error-handlers.js"),
		to: "js/[name][ext]",
	},
	{
		from: resolveFromRoot("client/*").replace(/\\/g, "/"),
		to: "[name][ext]",
		globOptions: {
			ignore: ["**/index.html.tpl", "**/service-worker.js", "**/*.d.ts", "**/tsconfig.json"],
		},
	},
	{
		from: resolveFromRoot("client/service-worker.js"),
		to: "[name][ext]",
		transform(content) {
			const hash = isProduction ? getVersionCacheBust() : "dev";
			return content.toString().replace("__HASH__", hash);
		},
	},
	{
		from: resolveFromRoot("client/audio/*").replace(/\\/g, "/"),
		to: "audio/[name][ext]",
	},
	{
		from: resolveFromRoot("client/img/*").replace(/\\/g, "/"),
		to: "img/[name][ext]",
	},
	{
		from: resolveFromRoot("client/themes/*").replace(/\\/g, "/"),
		to: "themes/[name][ext]",
	},
];

function createBaseConfig(mode, isProduction) {
	return {
		mode,
		entry: {
			"js/bundle.js": [resolveFromRoot("client/js/vue.ts")],
		},
		devtool: "source-map",
		output: {
			clean: true,
			path: resolveFromRoot("public"),
			filename: "[name]",
			// Content-hashed: served as immutable (server/staticAssets.ts)
			chunkFilename: "js/chunk.[contenthash:8].js",
			publicPath: "/",
		},
		performance: {
			hints: false,
		},
		resolve: {
			extensions: [".ts", ".js", ".vue"],
			// Tests import TypeScript and Vue files with the ".js" suffix that
			// Node ESM needs, as the server does
			extensionAlias: {".js": [".ts", ".js"]},
		},
		module: {
			rules: [
				{
					test: /\.vue$/,
					use: {
						loader: "vue-loader",
						options: {
							compilerOptions: {
								preserveWhitespace: false,
							},
							appendTsSuffixTo: [/\.vue$/],
							// The test bundle targets Node; without this vue-loader
							// would compile components for server-side rendering only
							isServerBuild: false,
						},
					},
				},
				{
					test: /\.ts$/i,
					include: [
						resolveFromRoot("client"),
						resolveFromRoot("shared"),
						resolveFromRoot("test"),
					],
					exclude: resolveFromRoot("node_modules"),
					use: {
						loader: "babel-loader",
						options: babelConfig,
					},
				},
				{
					test: /\.css$/,
					use: [
						{
							loader: MiniCssExtractPlugin.loader,
							options: {
								esModule: false,
							},
						},
						{
							loader: "css-loader",
							options: {
								url: false,
								importLoaders: 1,
								sourceMap: true,
							},
						},
						{
							loader: "postcss-loader",
							options: {
								sourceMap: true,
								// The plugins from postcss.config.js, imported here rather
								// than found by postcss-loader: it would require() them,
								// and under tsx (yarn dev) that breaks cssnano, an ES
								// module importing a CommonJS one
								postcssOptions: {...postcssConfig, config: false},
							},
						},
					],
				},
			],
		},
		optimization: {
			splitChunks: {
				cacheGroups: {
					commons: {
						test: /[\\/]node_modules[\\/]/,
						name: "js/bundle.vendor.js",
						chunks: "all",
					},
				},
			},
		},
		externals: {
			json3: "JSON",
		},
		plugins: [
			...(skipTypeCheck ? [] : [createForkTsCheckerPlugin(true)]),
			new VueLoaderPlugin(),
			new DefinePlugin({
				__VUE_PROD_DEVTOOLS__: false,
				__VUE_OPTIONS_API__: false,
			}),
			createMiniCssExtractPlugin(),
			new CopyPlugin({patterns: copyPatterns(isProduction)}),
			new NormalModuleReplacementPlugin(/debug/, resolveFromRoot("scripts/noop.js")),
			...(isProduction ? [new PrecompressPlugin()] : []),
		],
	};
}

function addIstanbulPlugin(rule) {
	if (!rule || typeof rule !== "object") {
		return rule;
	}

	const {use} = rule;

	if (use && typeof use === "object" && !Array.isArray(use) && use.loader === "babel-loader") {
		const options = {...(use.options ?? {})};
		const plugins = Array.isArray(options.plugins) ? [...options.plugins] : [];

		if (!plugins.includes("istanbul")) {
			plugins.push("istanbul");
		}

		return {
			...rule,
			use: {
				...use,
				options: {
					...options,
					plugins,
				},
			},
		};
	}

	return rule;
}

function applyDevelopmentOverrides(config) {
	const devConfig = {...config};

	devConfig.target = "node";
	// @vue/test-utils inlines a UMD build of js-beautify whose AMD branch
	// names files that aren't shipped; take its CommonJS branch instead
	devConfig.amd = false;
	devConfig.devtool = "eval";
	devConfig.stats = "errors-only";
	devConfig.output = {
		...(devConfig.output ?? {}),
		path: resolveFromRoot("test/public"),
		// Loaded with require(), so CommonJS whatever package.json says
		chunkFilename: "js/chunk.[id].cjs",
	};
	devConfig.entry = {
		...(devConfig.entry ?? {}),
		"testclient.cjs": [resolveFromRoot("test/client/index.ts")],
	};
	devConfig.optimization = {
		...(devConfig.optimization ?? {}),
		splitChunks: false,
	};
	devConfig.plugins = [
		...(skipTypeCheck ? [] : [createForkTsCheckerPlugin(false)]),
		new VueLoaderPlugin(),
		createMiniCssExtractPlugin(),
		new CopyPlugin({patterns: copyPatterns(false)}),
		new NormalModuleReplacementPlugin(
			/js(\/|\\)socket\.[jt]s$/,
			resolveFromRoot("scripts/noop.js")
		),
	];

	if (devConfig.module && Array.isArray(devConfig.module.rules)) {
		devConfig.module = {
			...devConfig.module,
			rules: devConfig.module.rules.map((rule) => addIstanbulPlugin(rule)),
		};
	}

	return devConfig;
}

export default (env = {}, argv = {}) => {
	const modeFromArgs = argv.mode ?? process.env.NODE_ENV ?? "development";
	const mode = typeof modeFromArgs === "string" ? modeFromArgs : "development";
	const isProduction = mode === "production";

	const baseConfig = createBaseConfig(mode, isProduction);

	if (mode === "development") {
		return applyDevelopmentOverrides(baseConfig);
	}

	return baseConfig;
};
