import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const PACKAGE_ROOT = "/Users/ofri/.nvm/versions/node/v24.14.1/lib/node_modules/@earendil-works/pi-coding-agent";
const PACKAGE_ALIASES = {
	"@earendil-works/pi-coding-agent": `${PACKAGE_ROOT}/dist/index.js`,
	"@earendil-works/pi-ai": `${PACKAGE_ROOT}/node_modules/@earendil-works/pi-ai/dist/index.js`,
	"@earendil-works/pi-tui": `${PACKAGE_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-agent-core": `${PACKAGE_ROOT}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,
	typebox: `${PACKAGE_ROOT}/node_modules/typebox/build/index.mjs`,
};

export async function resolve(specifier, context, defaultResolve) {
	const packagePath = PACKAGE_ALIASES[specifier];
	if (packagePath) {
		return defaultResolve(pathToFileURL(packagePath).href, context, defaultResolve);
	}

	if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
		const parentPath = fileURLToPath(context.parentURL);
		const tsPath = path.resolve(path.dirname(parentPath), specifier.slice(0, -3) + ".ts");
		try {
			await access(tsPath);
			return defaultResolve(pathToFileURL(tsPath).href, context, defaultResolve);
		} catch {
			// fall through
		}
	}

	return defaultResolve(specifier, context, defaultResolve);
}
