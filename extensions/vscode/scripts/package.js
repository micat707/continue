const { exec } = require("child_process");
const fs = require("fs");

const version = JSON.parse(
  fs.readFileSync("./package.json", { encoding: "utf-8" }),
).version;

const args = process.argv.slice(2);
let target;

if (args[0] === "--target") {
  target = args[1];
}

if (!fs.existsSync("build")) {
  fs.mkdirSync("build");
}

const isPreRelease = args.includes("--pre-release");

// 本 fork:固定输出名 build/continue.vsix(不带版本号/target),
// 这样 VS Code fork 的 product.json 用固定相对路径指向它即可,Continue 升版本也无需改配置。
const outFile = "./build/continue.vsix";

let command = isPreRelease
  ? `npx @vscode/vsce package --out ${outFile} --pre-release --no-dependencies` // --yarn"
  : `npx @vscode/vsce package --out ${outFile} --no-dependencies`; // --yarn";

if (target) {
  command += ` --target ${target}`;
}

exec(command, (error) => {
  if (error) {
    throw error;
  }
  console.log(
    `vsce package completed - extension created at extensions/vscode/build/continue.vsix (version ${version})`,
  );
});
