import { fileURLToPath } from "node:url";
import { parseDoctorArgs, renderDoctorHuman, renderDoctorJson, runDoctor } from "./doctor.js";

// The generated CLI lives one level below the package root. An npm executable runs
// from any directory, so the working directory says nothing about the package.
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const options = parseDoctorArgs(process.argv.slice(2));
if (!options) { process.stderr.write("Usage: doctor [--json]\n"); process.exitCode = 64; }
else {
  const result = await runDoctor({ packageRoot: PACKAGE_ROOT });
  process.stdout.write(options.json ? renderDoctorJson(result) : renderDoctorHuman(result));
  process.exitCode = result.exitCode;
}
