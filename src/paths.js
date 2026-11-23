// Où vivent les fichiers de Cube Hub LLM.
const os = require('os');
const path = require('path');

const baseDir = process.env.CUBE_LLM_DIR || path.join(os.homedir(), '.cube-hub-llm');

module.exports = {
  baseDir,
  soundsDir: path.join(baseDir, 'Sons'),
  stateFile: path.join(baseDir, 'reglages.json'),
  keyFile: path.join(baseDir, 'cle-api.bin'),
};
