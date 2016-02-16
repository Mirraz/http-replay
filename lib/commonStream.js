const {Cu, CC} = require("chrome");

const BinaryInputStream = CC('@mozilla.org/binaryinputstream;1', 'nsIBinaryInputStream', 'setInputStream');
const BinaryOutputStream = CC('@mozilla.org/binaryoutputstream;1', 'nsIBinaryOutputStream', 'setOutputStream');
const ObjectOutputStream = CC('@mozilla.org/binaryoutputstream;1', 'nsIObjectOutputStream', 'setOutputStream');
const Pipe = CC('@mozilla.org/pipe;1', 'nsIPipe', 'init');
const PR_UINT32_MAX = 0xffffffff;

exports.BinaryInputStream = BinaryInputStream;
exports.BinaryOutputStream = BinaryOutputStream;
exports.ObjectOutputStream = ObjectOutputStream;
exports.Pipe = Pipe;
exports.PR_UINT32_MAX = PR_UINT32_MAX;

