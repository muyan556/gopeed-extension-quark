const path = require('path');
const GopeedPolyfillWebpackPlugin = require('gopeed-polyfill-webpack-plugin');

module.exports = {
  entry: './src/index.js',
  output: {
    filename: 'index.js',
    path: path.resolve(__dirname, 'dist'),
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', {
                targets: { browsers: ['last 2 versions', 'not dead'] },
                useBuiltIns: 'usage',
                corejs: 3
              }]
            ]
          }
        }
      }
    ]
  },
  plugins: [new GopeedPolyfillWebpackPlugin()],
  resolve: { extensions: ['.js'] }
};
