const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext();
  console.log('WXContext:', wxContext);
  return {
    openid: wxContext.FROM_OPENID || wxContext.OPENID,
    appid: wxContext.FROM_APPID || wxContext.APPID,
  };
};