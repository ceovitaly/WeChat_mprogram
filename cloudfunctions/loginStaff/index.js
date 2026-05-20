const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

/**
 * Функция авторизации персонала
 * @param {string} username - Имя пользователя из инпута
 * @param {string} password - Пароль из инпута
 */
exports.main = async (event, context) => {
  const { username, password } = event;
  const wxContext = cloud.getWXContext();

  try {
    // Поиск пользователя в коллекции staff по имени и паролю
    const staffRes = await db.collection('staff').where({
      name: username,
      password: password
    }).get();

    if (staffRes.data.length === 0) {
      return {
        success: false,
        message: 'Неверный логин или пароль'
      };
    }

    const user = staffRes.data[0];

    // ЛОГИКА ОПРЕДЕЛЕНИЯ РОЛИ:
    // 1. Если в базе явно прописано user.role (например, 'admin'), берем её.
    // 2. Если роли нет, но это ваш логин (например, "Beppe"), ставим 'admin'.
    // 3. Во всех остальных случаях — 'counter'.
    let role = user.role || 'counter';
    
    // Замените "Beppe" на имя вашего основного аккаунта админа, если в базе нет поля role
    if (!user.role && user.name === "Beppe") {
      role = 'admin';
    }

    // Обновляем openid пользователя при входе, чтобы привязать устройство
    await db.collection('staff').doc(user._id).update({
      data: {
        lastOpenid: wxContext.OPENID,
        lastLogin: db.serverDate()
      }
    });

    return {
      success: true,
      data: {
        _id: user._id,
        name: user.name,
        role: role,
        openid: wxContext.OPENID
      }
    };

  } catch (err) {
    console.error(err);
    return {
      success: false,
      message: 'Ошибка сервера: ' + err.message
    };
  }
};