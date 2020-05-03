$ = window.$ = window.jQuery = require('jquery')
import * as _ from "lodash"
import Logline from 'logline'
import Dexie from 'dexie';
import {DateTime} from 'luxon'
import {tasks, mapFrequency, getTasks, getTask} from './tasks'
import {rand, getSetting, saveSetting} from './utils'
import {getLoginState} from './account'

const db = new Dexie("messages");
db.version(1).stores({ messages: "++id,type,timestamp" });

async function newMessage(messageId, data) {
  let order = await db.messages.where('id').equals(messageId).toArray();
  if (order && order.length > 0) return await db.messages.update(messageId, data)
  let messageInfo = Object.assign(data, {
    id: messageId,
  })
  return await db.messages.add(messageInfo);
}

async function updateMessages() {
  // 最多只展示最近 30 天的消息
  let last30Day = Date.now() - 60*60*1000*24*30;
  let messages = await db.messages.where('timestamp').above(last30Day).reverse().sortBy('timestamp')
  saveSetting('messages', messages)
  chrome.runtime.sendMessage({
    action: "messages_updated",
    messages: messages
  });
}

Logline.using(Logline.PROTOCOL.INDEXEDDB)

var logger = {}
var mobileUAType = getSetting('uaType', 1)

// 设置默认频率
_.forEach(tasks, (task) => {
  let frequency = getSetting(`task-${task.id}_frequency`)
  if (!frequency) {
    localStorage.setItem(`task-${task.id}_frequency`, task.frequency)
  }
})

// This is to remove X-Frame-Options header, if present
chrome.webRequest.onHeadersReceived.addListener(
  function(info) {
    var headers = info.responseHeaders;
    for (var i=headers.length-1; i>=0; --i) {
      var header = headers[i].name.toLowerCase();
      if (header == 'x-frame-options' || header == 'frame-options') {
          headers.splice(i, 1); // Remove header
      }
    }
    return {responseHeaders: headers};
  },
  {
      urls: ['*://*.taobao.com/*', '*://*.tmall.com/*', '*://*.fliggy.com/*'],
      types: ['sub_frame']
  },
  ['blocking', 'responseHeaders']
);

chrome.runtime.onInstalled.addListener(function (object) {
  let installed = localStorage.getItem('installed')
  let uaType = localStorage.getItem('uaType')
  if (installed) {
    if (!uaType) {
      localStorage.setItem('uaType', 1);
    }
    localStorage.setItem('oldUser', 'Y')
    console.log("已经安装")
  } else {
    localStorage.setItem('installed', 'Y');
    localStorage.setItem('uaType', rand(3));
    chrome.tabs.create({url: "/start.html"}, function (tab) {
      console.log("茶友会安装成功！");
    });
  }
});


var popularPhoneUA = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 9_1 like Mac OS X) AppleWebKit/601.1.46 (KHTML, like Gecko) Version/9.0 Mobile/13B143 Safari/601.1 AliApp(TB-PD/3.0.2)',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 9_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/10.2 Mobile/15E148 Safari/604.1 AliApp(TB-PD/3.0.2)',
  'Mozilla/5.0 (iPhone9,4; U; CPU iPhone OS 10_0_1 like Mac OS X) AppleWebKit/602.1.50 (KHTML, like Gecko) Version/10.0 Mobile/14A403 Safari/602.1 AliApp(TB-PD/3.0.2)',
  'Mozilla/5.0 (Linux; Android 6.0.1; SM-G920V Build/MMB29K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.98 Mobile Safari/537.36 AliApp(TB-PD/2.6.5)'
];
chrome.webRequest.onBeforeSendHeaders.addListener(
  function (details) {
    for (var i = 0; i < details.requestHeaders.length; ++i) {
      if (details.requestHeaders[i].name === 'User-Agent') {
        details.requestHeaders[i].value = popularPhoneUA[mobileUAType];
        break;
      }
    }
    return {
      requestHeaders: details.requestHeaders
    };
  }, {
    urls: [
      "*://*.m.taobao.com/*",
    ]
  }, ['blocking', 'requestHeaders']);


// 判断浏览器
try {
  browser.runtime.getBrowserInfo().then(function (browserInfo) {
    localStorage.setItem('browserName', browserInfo.name);
  })
} catch (error) {}


chrome.alarms.onAlarm.addListener(function( alarm ) {
  log('background', "onAlarm", alarm)
  let taskId = alarm.name.split('_')[1]
  switch(true){
    // 计划任务
    case alarm.name.startsWith('runScheduleJob'):
      runJob(taskId, true)
      break;
    // 定时任务
    case alarm.name.startsWith('runJob'):
      runJob(taskId)
      break;
    // 周期运行（10分钟）
    case alarm.name == 'cycleTask':
      clearPinnedTabs()
      findJobs()
      runJob()
      updateIcon()
      break;
    case alarm.name.startsWith('clearIframe'):
      resetIframe(taskId || 'iframe')
      break;
    case alarm.name.startsWith('destroyIframe'):
      $("#" + taskId).remove();
      break;
    case alarm.name.startsWith('closeTab'):
      try {
        chrome.tabs.get(taskId, (tab) => {
          if (tab) {
            chrome.tabs.remove(tab.id)
          }
        })
      } catch (e) {}
      break;
    case alarm.name == 'reload':
      chrome.runtime.reload()
      chrome.alarms.clearAll()
      // 保留3天内的log
      Logline.keep(3);
      break;
  }
})

// 保存任务栈
function saveJobStack(jobStack) {
  jobStack = _.uniq(jobStack)
  localStorage.setItem('jobStack', JSON.stringify(jobStack));
}



function scheduleJob(task) {
  let hour = DateTime.local().hour;
  for (var i = 0, len = task.schedule.length; i < len; i++) {
    let scheduledHour = task.schedule[i]
    if (scheduledHour > hour) {
      let scheduledTime = DateTime.local().set({
        hour: scheduledHour,
        minute: rand(2) - 1,
        second: rand(55)
      }).valueOf()
      chrome.alarms.create('runScheduleJob_' + task.id, {
        when: scheduledTime
      })
      log('background', "schedule job created", {
        job: task,
        time: scheduledHour,
        when: scheduledTime
      })
      break;
    }
  }
}

// 寻找乔布斯
function findJobs() {
  let jobStack = getSetting('jobStack', [])
  let taskList = getTasks()
  taskList.forEach(function(task) {
    if (task.suspended) {
      return console.log(task.title, '由于账号未登录已暂停运行')
    }
    // 如果任务有时间安排，则把任务安排到最近的下一个时段
    if (task.schedule) {
      return chrome.alarms.get('runScheduleJob_' + task.id, function (alarm) {
        if (!alarm || alarm.scheduledTime < Date.now()) {
          return scheduleJob(task)
        } else {
          console.log("job already scheduled ", alarm)
        }
      })
    }
    switch(task.frequency){
      case '2h':
        // 如果从没运行过，或者上次运行已经过去超过2小时，那么需要运行
        if (!task.last_run_at || (DateTime.local() > DateTime.fromMillis(task.last_run_at).plus({ hours: 2 }))) {
          jobStack.push(task.id)
        }
        break;
      case '5h':
        // 如果从没运行过，或者上次运行已经过去超过5小时，那么需要运行
        if (!task.last_run_at || (DateTime.local() > DateTime.fromMillis(task.last_run_at).plus({ hours: 5 }))) {
          jobStack.push(task.id)
        }
        break;
      case 'daily':
        // 如果从没运行过，或者上次运行不在今天，或者是签到任务但未完成
        if (!task.last_run_at || !(DateTime.local().hasSame(DateTime.fromMillis(task.last_run_at), 'day')) || (task.checkin && !task.checked)) {
          jobStack.push(task.id)
        }
        break;
      default:
        console.log('ok, never run ', task.title)
    }
  });
  saveJobStack(jobStack)
}

function log(type, message, details) {
  if (!logger[type]) {
    logger[type] = new Logline(type)
  }
  logger[type].info(message, details)
  console.log(new Date(), type, message, details)
}

function resetIframe(domId) {
  $("#" + domId).remove();
  let iframeDom = `<iframe id="${domId}" width="400 px" height="600 px" src=""></iframe>`;
  $('body').append(iframeDom);
}

function incrementUsage(task) {
  let year = new Date().getFullYear()
  let today = DateTime.local().toFormat("o")
  let hour = new Date().getHours()
  saveSetting(`temporary:usage-${task.id}_${year}d:${today}:h:${hour}`, task.usage.hour + 1)
  saveSetting(`temporary:usage-${task.id}_${year}d:${today}`, task.usage.daily  + 1)
}

// 执行组织交给我的任务
function runJob(taskId, force = false) {
  // 不在凌晨阶段运行非强制任务
  if (DateTime.local().hour < 6 && !force) {
    return console.log('Silent Night')
  }
  log('background', "run job", {
    jobId: taskId,
    force: force
  })
  // 如果没有指定任务ID 就从任务栈里面找一个
  if (!taskId) {
    let jobStack = getSetting('jobStack', [])
    if (jobStack && jobStack.length > 0) {
      taskId = jobStack.shift();
      saveJobStack(jobStack)
    } else {
      return log('info', new Date(), '好像没有什么事需要我做...')
    }
  }
  let task = getTask(taskId)

  // 如果任务已暂停
  if (task.pause) {
    return log('job', task.title, '由于运行次数超限而被暂停')
  }

  // 如果任务暂停或者已经完成
  if ((task.suspended || task.checked) && !force) {
    return log('job', task.title, '由于账号未登录已暂停运行')
  }
  if (task && (task.frequency != 'never' || force)) {
    log('background', "run", task)
    incrementUsage(task)
    if (task.mode == 'iframe') {
      openByIframe(task.url, 'job')
    } else {
      chrome.tabs.create({
        index: 1,
        url: task.url,
        active: false,
        pinned: true
      }, function (tab) {
        // 将标签页静音
        chrome.tabs.update(tab.id, {
          muted: true
        }, function (result) {
          log('background', "muted tab", result)
        })
        chrome.alarms.create('closeTab_'+tab.id, {delayInMinutes: 3})
      })
    }
  }
}

function openByIframe(src, type, delayTimes = 0) {
  // 加载新的任务
  let iframeId = "iframe"
  let keepMinutes = 5
  if (type == 'temporary') {
    iframeId = 'iframe' + rand(10241024)
    keepMinutes = 1
  }
  // 当前任务过多则等待
  if ($('iframe').length > 5 && delayTimes < 6) {
    setTimeout(() => {
      openByIframe(src, type, delayTimes + 1)
    }, (10 + rand(10)) * 1000);
    return console.log('too many iframe pages', src, delayTimes)
  }
  // 运行
  resetIframe(iframeId)
  $("#" + iframeId).attr('src', src)
  // 设置重置任务
  chrome.alarms.create((type == 'temporary' ? 'destroyIframe_' : 'clearIframe_') + iframeId, {
    delayInMinutes: keepMinutes
  })
}

function updateUnreadCount(change = 0) {
  let lastUnreadCount = localStorage.getItem('unreadCount') || 0
  let unreadCount = parseInt(Number(lastUnreadCount) + change)
  if (unreadCount < 0) {
    unreadCount = 0
  }
  localStorage.setItem('unreadCount', unreadCount);
  if (unreadCount > 0) {
    let unreadCountText = unreadCount.toString()
    if (unreadCount > 100) {
      unreadCountText = '99+'
    }
    chrome.browserAction.setBadgeText({ text: unreadCountText });
    chrome.browserAction.setBadgeBackgroundColor({ color: "#4caf50" });
  } else {
    chrome.browserAction.setBadgeText({ text: "" });
  }
}

$( document ).ready(function() {
  log('background', "document ready")
  // 每10分钟运行一次定时任务
  chrome.alarms.create('cycleTask', {
    periodInMinutes: 10
  })

  // 每600分钟完全重载
  chrome.alarms.create('reload', {periodInMinutes: 600})

  // 载入后马上运行一次任务查找
  findJobs()

  // 载入显示未读数量
  updateUnreadCount()

  // 加载任务参数
  loadSettingsToLocalStorage('teaclub:task-parameters')
  loadSettingsToLocalStorage('teaclub:action-links')

  // 加载推荐设置
  loadRecommendSettingsToLocalStorage()
})


function openWebPageAsMobile(url) {
  chrome.windows.create({
    width: 420,
    height: 800,
    url: url,
    type: "popup"
  });
}

// 清除不需要的tab
function clearPinnedTabs() {
  chrome.tabs.query({
    pinned: true
  }, function (tabs) {
    var tabIds = $.map(tabs, function (tab) {
      if (tab && tab.url.indexOf('jd.com') !== -1) {
        return tab.id
      }
    })

    // opera doesn't remove pinned tabs, so lets first unpin
    $.map(tabIds, function (tabId) {
        chrome.tabs.update(tabId, {"pinned":false}, function(theTab){ chrome.tabs.remove(theTab.id); });
    })
  })
}

// 点击通知
chrome.notifications.onClicked.addListener(function (notificationId) {
  if (notificationId.split('_').length > 0) {
    let type = notificationId.split('_')[1]
    if (type && type.length > 1) {
      switch (type) {
        case 'fliggy':
          chrome.tabs.create({
            url: "https://teaclub.zaoshu.so/sites/fliggy"
          })
          break;
        default:
          chrome.tabs.create({
            url: "https://teaclub.zaoshu.so/sites/taobao"
          })
      }
    }
  }
})

// 根据登录状态调整图标显示
function updateIcon() {
  let loginState = getLoginState()
  switch (loginState.class) {
    case 'alive':
      chrome.browserAction.getBadgeText({}, function (text){
        if (text == "X" || text == " ! ") {
          chrome.browserAction.setBadgeText({
            text: ""
          });
          chrome.browserAction.setTitle({
            title: "茶友会"
          })
        }
      })
      chrome.browserAction.setIcon({
        path : {
          "19": "static/image/icon@19.png",
          "38": "static/image/icon@38.png"
        }
      });
      chrome.contextMenus.removeAll();

      break;
    case 'failed':
      chrome.browserAction.setBadgeBackgroundColor({
        color: [190, 190, 190, 230]
      });
      chrome.browserAction.setBadgeText({
        text: "X"
      });
      chrome.browserAction.setTitle({
        title: "账号登录失效"
      })
      chrome.contextMenus.removeAll();
      chrome.contextMenus.create({
        title: "账号登录失效，点击登录",
        contexts: ["browser_action"],
        onclick: function() {
          openLoginPage()
        }
      });
      break;
    case 'warning':
      chrome.browserAction.setBadgeBackgroundColor({
        color: "#EE7E1B"
      });
      chrome.browserAction.setBadgeText({
        text: " ! "
      });
      chrome.contextMenus.removeAll();
      chrome.contextMenus.create({
        title: "账号登录失效，点击登录",
        contexts: ["browser_action"],
        onclick: function() {
          openLoginPage()
        }
      });
      break;
    default:
      break;
  }
}

function openLoginPage() {
  chrome.tabs.create({
    url: "https://i.taobao.com/my_taobao.htm"
  })
}

// 保存登录状态
function saveLoginState(loginState) {
  let previousState = getLoginState()
  localStorage.setItem('login-state_' + loginState.type, JSON.stringify({
    time: new Date(),
    message: loginState.content || loginState.message,
    state: loginState.state
  }));
  chrome.runtime.sendMessage({
    action: "loginState_updated",
    data: loginState
  });
  // 如果登录状态从失败转换到了在线
  if (previousState.class != 'alive' && loginState.state == "alive") {
    console.log('user account turn alive')
    setTimeout(() => {
      findJobs()
    }, 5000);
    setTimeout(() => {
      runJob()
    }, 15000);
  }
}

// 浏览器通知（合并）
// mute_night
function sendChromeNotification(id, content) {
  let hour = DateTime.local().hour;
  let muteNight = getSetting('mute_night');
  if (muteNight && hour < 6) {
    log('background', 'mute_night', content);
  } else {
    chrome.notifications.create(id, content)
    log('message', id, content);
  }
}


function runTask(msg, sendResponse) {
  let task = getTask(msg.taskId)
  // set 临时运行
  localStorage.setItem('temporary_job' + task.id + '_frequency', 'onetime');
  // 任务因为频率受限无法运行
  if (task.pause) {
    sendChromeNotification(new Date().getTime().toString(), {
      type: "basic",
      title: "任务因为频率受限无法运行",
      message: task.title + "已达到最大时段频率，每小时：" + task.rateLimit.hour,
      iconUrl: 'static/image/128.png'
    })
    sendResponse({
      result: "pause",
      message: "任务因为频率受限无法运行"
    })
  } else {
    runJob(task.id, true)
    sendResponse({
      result: "success"
    })
    if (!msg.hideNotice) {
      sendChromeNotification(new Date().getTime().toString(), {
        type: "basic",
        title: "正在重新运行" + task.title,
        message: "任务运行大约需要2分钟，如果有情况我再叫你（请勿连续运行）",
        iconUrl: 'static/image/128.png'
      })
    }
  }
}

function markCheckinStatus(msg) {
  let task = getTask(msg.taskId)
  if (task) {
    let year = new Date().getFullYear()
    let checkinKey = `checkin_${task.key}`
    let currentStatus = getSetting(checkinKey, null)
    let data = {
      date: DateTime.local().toFormat("o"),
      time: new Date(),
      value: msg.value
    }
    if (msg.month) {
      localStorage.setItem(`order-fliggy-${year}-${msg.month}`, 'Y');
    }
    if (msg.orderId) {
      localStorage.setItem(`order-fliggy_${msg.orderId}`, 'Y');
    }
    if (currentStatus && currentStatus.date == DateTime.local().toFormat("o")) {
      console.log('已经记录过今日签到状态了')
    } else {
      localStorage.setItem(checkinKey, JSON.stringify(data));
      return data
    }
  }
}

function updateRunStatus(msg) {
  let task = getTask(msg.taskId)
  if (task) {
    localStorage.setItem('task-' + task.id + '_lasttime', new Date().getTime())
    saveLoginState({
      content: task.title + "成功运行",
      state: "alive",
      type: msg.mode || task.type[0]
    })
    // 如果任务周期小于10小时，且不是计划任务，则安排下一次运行
    if (mapFrequency[task.frequency] < 600 && !task.schedule) {
      chrome.alarms.create('runJob_' + task.id, {
        delayInMinutes: mapFrequency[task.frequency]
      })
    }
  }
}

// 加载任务参数
function loadSettingsToLocalStorage(key) {
  $.getJSON(`https://teaclub.zaoshu.so/setting/${key}`, function (json) {
    saveSetting(key, json)
  })
}

// 加载推荐设置
function loadRecommendSettingsToLocalStorage() {
  $.getJSON("https://teaclub.zaoshu.so/setting/teaclub:recommend", function (json) {
    if (json.displayPopup) {
      saveSetting('displayPopup', json.displayPopup)
    }
    if (json.events) {
      saveSetting('events', json.events)
    }
    if (json.announcements && json.announcements.length > 0) {
      saveSetting('announcements', json.announcements)
    }
    if (json.promotions) {
      saveSetting('promotions', json.promotions)
    }
    if (json.recommendedLinks && json.recommendedLinks.length > 0) {
      saveSetting('recommendedLinks', json.recommendedLinks)
    } else {
      localStorage.removeItem('recommendedLinks')
    }
    if (json.recommendServices && json.recommendServices.length > 0) {
      saveSetting('recommendServices', json.recommendServices)
    }
  });
}


function sendMessageToPage(targetPage, data) {
  chrome.tabs.sendMessage(targetPage.tab.id, data, {}, function (response) {
    console.log('send message to tabs response', data, response)
  })
}

function timeoutPromise(promise, ms) {
  return new Promise(function(resolve, reject) {
    setTimeout(function() {
      reject(new Error("timeout"))
    }, ms)
    promise.then(resolve, reject)
  })
}

// 查找优惠券
async function searchCoupon(params) {
  try {
    let response = await timeoutPromise(fetch(`http://127.0.0.1:3824/coupon/search?sku=${params.sku}&keyword=${params.title}&merchant=${params.merchant}`), 5000)
    let details = await response.json();
    return details;
  } catch (error) {
    console.error(error)
    return null
  }
}

// 处理消息通知
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (!msg.action) {
    msg.action = msg.text
  }
  let loginState = getLoginState()
  log('msg', new Date(), msg);
  switch(msg.action){
    // 保存登录状态
    case 'saveLoginState':
      saveLoginState(msg)
      break;
    // 获取登录状态
    case 'getLoginState':
      sendResponse(loginState)
      break;
    // 打开登录页面
    case 'openLogin':
      openLoginPage()
      break;
    // 保存变量值
    case 'setVariable':
      localStorage.setItem(msg.key, JSON.stringify(msg.value));
      break;
    // 获取设置
    case 'getSetting':
      let setting = getSetting(msg.content)
      let temporarySetting = localStorage.getItem('temporary_' + msg.content)
      // 如果存在临时设置
      if (temporarySetting) {
        // 临时设置5分钟失效
        setTimeout(() => {
          localStorage.removeItem('temporary_' + msg.content)
        }, 60*5*1000);
        return sendResponse(temporarySetting)
      }
      sendResponse(setting)
      break;
    // 领取订单的里程
    case 'getOrderFliggy':
      let orderStatus = localStorage.getItem(`order-fliggy_${msg.orderId}`)
      console.log('getOrderFliggy', msg.orderId, orderStatus)
      // 如果没有领取过
      if (!(orderStatus && orderStatus == 'Y')) {
        let url = `https://www.fliggy.com/mytrip/?tvm=tcd&orderId=${msg.orderId}`
        setTimeout(() => {
          openByIframe(url, 'temporary')
        }, rand(20) * 1000);
      }
      sendResponse({
        working: true
      })
      break;
    case 'openUrlAsMobile':
      openWebPageAsMobile(msg.url)
      break;
    case 'option':
      localStorage.setItem(''+msg.title, msg.content);
      break;
    // 查询消息列表
    case 'getMessages':
      setTimeout(async () => {
        await updateMessages()
      }, 50);
      break;
    // 手动运行任务
    case 'runTask':
      runTask(msg, sendResponse)
      break;
    // 签到通知
    case 'checkin_notice':
      let mute_checkin = getSetting('mute_checkin')
      if (mute_checkin && mute_checkin == 'checked' && !msg.test) {
        console.log('checkin', msg)
      } else {
        let icon = 'static/image/coin.png'
        let type = "basic"
        if (msg.type == 'mileage') {
          icon = 'static/image/mileage.png'
          type = 'fliggy'
        }
        sendChromeNotification( new Date().getTime().toString() + '_' + msg.reward, {
          type: type,
          title: msg.title,
          message: msg.content,
          iconUrl: icon
        })
      }
      break;
    // 签到状态
    case 'markCheckinStatus':
      let result = markCheckinStatus(msg)
      sendResponse({
        result
      })
      break;
    // 更新运行状态
    case 'updateRunStatus':
      updateRunStatus(msg)
      sendResponse({
        result: true
      })
      break;
    // 查询优惠券
    case 'queryCoupon':
      var disable_same_goods = getSetting('disable_same_goods')
      setTimeout(async () => {
        let result = await searchCoupon(msg.params)
        if (disable_same_goods) {
          result.similarGoods = null
        }
        sendMessageToPage(sender, {
          type: "couponInfo",
          content: result
        })
      }, 50);
      sendResponse({
        result: true
      })
      break;
    case 'coupon':
      var coupon = msg.content
      var mute_coupon = getSetting('mute_coupon')
      if (mute_coupon && mute_coupon == 'checked') {
        console.log('coupon', msg)
      } else {
        sendChromeNotification( new Date().getTime().toString() + "_coupon_" + coupon.batch, {
          type: "basic",
          title: msg.title,
          message: coupon.name + coupon.price,
          isClickable: true,
          iconUrl: 'static/image/coupon.png'
        })
      }
      break;
    case 'clearUnread':
      updateUnreadCount(-999)
      break;
    case 'myTab':
      sendResponse({
        tab: sender.tab
      });
      break;
    default:
      console.log("Received %o from %o, frame", msg, sender.tab, sender.frameId);
  }
  // 更新图标
  updateIcon()
  // 保存消息
  switch (msg.action) {
    case 'coupon':
    case 'notice':
    case 'checkin_notice':
      if (msg.test) {
        break;
      }
      let message = {
        type: msg.type || msg.action, // 通知的类型
        batch: msg.batch, // 批次，通常是优惠券的属性
        reward: msg.reward, // 奖励的类型
        unit: msg.unit || msg.reward || msg.batch, // 奖励的单位
        value: msg.value, // 奖励的数量
        title: msg.title,
        content: msg.content,
        timestamp: Date.now()
      }
      let uuid = msg.uuid || Date.now()
      updateUnreadCount(1)
      setTimeout(async () => {
        await newMessage(uuid, message);
      }, 50);
      setTimeout(async () => {
        await updateMessages()
      }, 3000);
      break;
  }

  if (msg.text != 'saveAccount') {
    log('message', msg.text, msg);
  }
  // 如果消息 300ms 未被回复
  return true
});

Logline.keep(3);