// 主题管理：日间 / 夜间（应用内偏好，不跟随系统）
const KEY = 'app_theme'
const TAB_ICONS = [
  { light: ['assets/icons/home.png', 'assets/icons/home-on.png'], dark: ['assets/icons/dark/home.png', 'assets/icons/dark/home-on.png'] },
  { light: ['assets/icons/calendar.png', 'assets/icons/calendar-on.png'], dark: ['assets/icons/dark/calendar.png', 'assets/icons/dark/calendar-on.png'] },
  { light: ['assets/icons/chart.png', 'assets/icons/chart-on.png'], dark: ['assets/icons/dark/chart.png', 'assets/icons/dark/chart-on.png'] },
  { light: ['assets/icons/user.png', 'assets/icons/user-on.png'], dark: ['assets/icons/dark/user.png', 'assets/icons/dark/user-on.png'] }
]

let theme = 'light'

function init() {
  try { theme = wx.getStorageSync(KEY) === 'dark' ? 'dark' : 'light' } catch (e) { theme = 'light' }
  return theme
}

function get() { return theme }

function set(t) {
  theme = t === 'dark' ? 'dark' : 'light'
  try { wx.setStorageSync(KEY, theme) } catch (e) { /* 忽略 */ }
  applyChrome()
  return theme
}

function toggle() { return set(theme === 'dark' ? 'light' : 'dark') }

// 同步导航栏与 tabBar（custom 导航栏无需染色，仅 tabBar）
function applyChrome() {
  const dark = theme === 'dark'
  try {
    wx.setTabBarStyle({
      backgroundColor: dark ? '#0D0D0B' : '#F2F1EC',
      borderStyle: dark ? 'black' : 'white',
      color: dark ? '#6F7166' : '#8A9084',
      selectedColor: dark ? '#AEBF9F' : '#55654B'
    })
    TAB_ICONS.forEach((it, i) => {
      const pair = dark ? it.dark : it.light
      wx.setTabBarItem({ index: i, iconPath: pair[0], selectedIconPath: pair[1] })
    })
  } catch (e) { /* 非 tab 页调用会失败，忽略 */ }
}

function statusBarHeight() {
  try { return wx.getWindowInfo().statusBarHeight || 44 } catch (e) { return 44 }
}

function statusBarClass() { return theme === 'dark' ? 'td' : '' }

module.exports = { init, get, set, toggle, applyChrome, statusBarHeight, statusBarClass }
