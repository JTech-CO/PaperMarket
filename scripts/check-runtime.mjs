if (process.versions.node.split('.')[0] !== '24') {
  throw new Error('PaperMarket requires Node.js 24 LTS. Use the version in .node-version.');
}
