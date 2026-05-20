const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_TYPE_ENV })

exports.main = async (event, context) => {
  const { fileContent, path } = event
  try {
    return await cloud.uploadFile({
      cloudPath: path,
      fileContent: Buffer.from(fileContent, 'base64'),
    })
  } catch (e) {
    return e
  }
}