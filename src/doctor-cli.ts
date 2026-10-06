import { parseDoctorArgs, renderDoctorHuman, renderDoctorJson, runDoctor } from "./doctor.js";

const options = parseDoctorArgs(process.argv.slice(2));
if (!options) { process.stderr.write("Usage: doctor [--json]\n"); process.exitCode = 64; }
else {
  const result = await runDoctor();
  process.stdout.write(options.json ? renderDoctorJson(result) : renderDoctorHuman(result));
  process.exitCode = result.exitCode;
}
