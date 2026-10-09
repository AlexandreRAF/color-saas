'use strict';

// A child owns one vehicle; shared provider capacity lives in the coordinator.
const { evaluate } = require('./evaluate_vehicles');
evaluate(process.argv[2], process.argv[3]).then(result => {
  process.send?.({ result }, () => process.disconnect?.());
}).catch(error => {
  process.send?.({ error: error.message }, () => process.disconnect?.());
  process.exitCode = 1;
});
