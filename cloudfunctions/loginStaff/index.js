const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const db = cloud.database();

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Функция авторизации персонала
 * @param {string} username - Имя пользователя из инпута
 * @param {string} password - Пароль из инпута
 */
exports.main = async (event, context) => {
  const { username, password } = event;
  const wxContext = cloud.getWXContext();
  const cleanUsername = (username || '').trim();

  try {
    // Поиск пользователя в коллекции staff по имени и паролю
    // Имя ищем без учёта регистра (whole-string regex, спецсимволы экранированы), пароль — строго как есть
    const staffRes = await db.collection('staff').where({
      name: db.RegExp({ regexp: '^' + escapeRegExp(cleanUsername) + '$', options: 'i' }),
      password: password
    }).get();

    if (staffRes.data.length === 0) {
      return {
        success: false,
        message: 'Неверный логин или пароль'
      };
    }

    // Небольшой штат сотрудников — считаем, что двух аккаунтов, отличающихся
    // только регистром имени, не заводят; при совпадении берём первого, как раньше
    const user = staffRes.data[0];

    // ЛОГИКА ОПРЕДЕЛЕНИЯ РОЛИ:
    // 1. Если в базе явно прописано user.role (например, 'admin'), берем её.
    // 2. Во всех остальных случаях — 'counter' (безопасный дефолт с наименьшими правами).
    let role = user.role || 'counter';

    // Гарантируем, что openid -> staff-документ всегда один-к-одному: снимаем этот
    // openid с любых ДРУГИХ документов staff перед тем, как проштамповать текущий.
    // Иначе два аккаунта, использованные с одного WeChat-аккаунта, оба несут один
    // lastOpenid, и серверный getCallerStaff (where({lastOpenid}).limit(1)) резолвит
    // произвольный из них — вплоть до эскалации counter -> admin.
    // Побочный эффект для случая «один общий staff-аккаунт на двух телефонах»:
    // побеждает последний вход, вызовы с более раннего телефона становятся
    // Unauthorized — это ожидаемое, задокументированное поведение.
    const _ = db.command;
    await db.collection('staff')
      .where({ lastOpenid: wxContext.OPENID, _id: _.neq(user._id) })
      .update({ data: { lastOpenid: '' } });

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