import { runModelBenchmark } from "../src/lib/email/benchmark";

runModelBenchmark()
  .then((runId) => {
    console.log(`Model benchmark completed: ${runId}`);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
