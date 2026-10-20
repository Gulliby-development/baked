import { sumColumn } from "./csv.ts";

const [file, column] = process.argv.slice(2);
try {
  if (!file || !column) throw new Error("usage: bun src/cli.ts FILE COLUMN");
  console.log(String(sumColumn(await Bun.file(file).text(), column)));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
