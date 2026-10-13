const store = require('../../utils/store')
const sync = require('../../utils/sync')
const api = require('../../utils/api')
const d = require('../../utils/date')
const theme = require('../../utils/theme')

const WEEKS = [
  { n: 1, label: '一' }, { n: 2, label: '二' }, { n: 3, label: '三' }, { n: 4, label: '四' },
  { n: 5, label: '五' }, { n: 6, label: '六' }, { n: 7, label: '日' }
]

Page({
  data: {
    statusBarH: 44, theme: 'light',
    accountShow: false, accountBusy: false, accountError: '', accountAuthorized: false,
    nickname: '', avatarUrl: '', accountNickname: '', accountAvatar: '',
    examDate: '', startDate: '',
    weekText: '', weekDays: 0,
    tplCount: 0, importing: false, importError: '', templateError: '',
    exporting: false, exportFile: null, exportError: '', downloading: false,
    // 编辑弹层
    sheet: '',            // '' | 'week' | 'tpl' | 'import'
    tmpWeeks: [], weekSel: [], weeks: WEEKS,
    tpl: [],
    // 导入预览
    importPreview: null,
    // 同步
    pending: 0, lastSyncText: '从未同步',
    // 重排预览
    previewShow: false, preview: null, saving: false
  },

  onLoad() { this.setData({ statusBarH: theme.statusBarHeight() }) },

  onShow() {
    this.setData({ theme: theme.get() })
    this.render()
    sync.flush().catch(() => {}).finally(() => this.render())
  },

  render() {
    const db = store.get()
    if (this._exportOwner && this._exportOwner !== db) {
      this._exportPath = ''
      this._exportOwner = null
      this.setData({ exportFile: null, exportError: '' })
    }
    const plan = db.planDraft || db.plan
    const weeks = plan ? (plan.studyWeekdays || []) : []
    this.setData({
      hasPlan: !!plan,
      hasDraft: !!db.planDraft,
      nickname: db.accountSignedOut ? '学习者' : db.profile.nickname || '学习者',
      avatarUrl: db.accountSignedOut ? '' : db.profile.avatarUrl || '',
      accountAuthorized: !db.accountSignedOut && !!db.profile.accountAuthorized,
      examDate: (db.profile && db.profile.examDate) || '',
      startDate: plan ? plan.startDate : d.todayStr(),
      weekText: weeks.length ? '每周' + weeks.map(w => '一二三四五六日'[w - 1]).join('、') : '尚未设置',
      weekDays: weeks.length,
      tplCount: plan && plan.template ? plan.template.length : 0,
      pending: sync.pendingCount(),
      lastSyncText: db.lastSync ? this.fmtSync(db.lastSync) : '从未同步'
    })
  },

  fmtSync(ts) {
    const diff = Math.round((Date.now() - ts) / 1000)
    if (diff < 60) return '刚刚'
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
    return new Date(ts).toLocaleDateString('zh-CN')
  },
  openAccount() {
    const p = store.get().profile || {}
    this._avatarUpload = ''
    this.setData({ accountShow: true, accountError: '', accountNickname: store.get().accountSignedOut ? '' : p.nickname || '', accountAvatar: store.get().accountSignedOut ? '' : p.avatarUrl || '' })
  },
  closeAccount() { if (!this.data.accountBusy) this.setData({ accountShow: false }) },
  chooseAvatar(e) {
    if (this.data.accountBusy || !e.detail.avatarUrl) return
    this._avatarUpload = ''
    this.setData({ accountAvatar: e.detail.avatarUrl, accountError: '' })
  },
  avatarError(e) {
    const detail = e.detail && e.detail.errMsg || ''
    const undeclared = /scope is not declared|privacy agreement/i.test(detail)
    this.setData({ accountError: undeclared
      ? '图片选择被微信拦截：请管理员在微信后台“用户隐私保护指引”中声明“选中的照片或视频信息”，用途填写“选择并上传账号头像”，发布生效后重新预览。'
      : detail || '头像选择失败，请检查隐私授权，或从相册选择' })
  },
  chooseAvatarPhoto() {
    if (this.data.accountBusy) return
    if (typeof wx.chooseMedia !== 'function') return this.setData({ accountError: '请在手机微信中选择头像' })
    const choose = () => wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
      success: res => { const file = res.tempFiles && res.tempFiles[0]; if (file) this.chooseAvatar({ detail: { avatarUrl: file.tempFilePath } }) },
      fail: e => { if (!/cancel/i.test(e.errMsg || '')) this.avatarError({ detail: e }) }
    })
    if (typeof wx.requirePrivacyAuthorize === 'function') wx.requirePrivacyAuthorize({ success: choose, fail: e => this.avatarError({ detail: e }) })
    else choose()
  },
  accountName(e) { this.setData({ accountNickname: e.detail.value }) },
  async loginAccount() {
    if (this.data.accountBusy) return
    this.setData({ accountBusy: true, accountError: '' })
    try {
      const p = await api.call('user', 'login', { authorize: true }, { silent: true })
      store.signIn(p)
      // 旧版云函数也支持login，云端身份识别成功后即可使用当前微信账号。
      store.applyServerBuckets({ profile: Object.assign({}, p, { accountAuthorized: true }) })
      this.render()
      await sync.flush().catch(() => {})
      try {
        const res = await api.call('data', 'exportAll', {}, { silent: true }), remote = res.payload
        const sessions = {}, logs = {}, habitLogs = {}
        ;(remote.sessions || []).filter(x => !x.deleted).forEach(x => { (sessions[x.date] || (sessions[x.date] = [])).push(x) })
        ;(remote.logs || []).forEach(x => { (logs[x.date] || (logs[x.date] = [])).push(x) })
        ;(remote.habitLogs || []).forEach(x => { (habitLogs[x.date] || (habitLogs[x.date] = {}))[x.habitId] = x.status })
        store.applyServerBuckets({ plan: (remote.plans || [])[0] || null, sessions, logs, habits: remote.habits || [], habitLogs })
        this.render()
      } catch (e) { this.setData({ accountError: '已登录，记录暂未完整刷新，请联网后重试' }) }
      this.setData({ accountNickname: p.nickname || this.data.accountNickname, accountAvatar: p.avatarUrl || this.data.accountAvatar })
      wx.showToast({ title: '微信登录成功', icon: 'success' })
    } catch (e) { this.setData({ accountError: e.message || '登录失败，请重试' }) }
    finally { this.setData({ accountBusy: false }) }
  },
  logoutAccount() {
    if (this.data.accountBusy) return
    return wx.showModal({
      title: '退出当前账号？',
      content: '退出后隐藏该账号的所有记录，云端记录不会删除。未同步内容在本机备份，下次登录恢复。',
      confirmText: '退出', cancelText: '取消',
      success: async res => {
        if (!res.confirm || this.data.accountBusy) return
        this.setData({ accountBusy: true })
        await sync.flush().catch(() => {})
        try { store.signOut() } catch (e) { this.setData({ accountBusy: false, accountError: e.message }); return }
        this._avatarUpload = ''
        this.setData({ accountShow: false, accountBusy: false, accountNickname: '', accountAvatar: '', accountError: '' })
        this.render()
        wx.showToast({ title: '已退出账号', icon: 'success' })
      }
    })
  },
  async saveAccount() {
    if (this.data.accountBusy) return
    if (!this.data.accountAuthorized) return this.setData({ accountError: '请先点击微信授权登录' })
    const nickname = this.data.accountNickname.trim()
    if (!nickname) return this.setData({ accountError: '请填写昵称' })
    this.setData({ accountBusy: true, accountError: '' })
    try {
      let avatarUrl = this.data.accountAvatar
      if (avatarUrl && !/^cloud:\/\//.test(avatarUrl)) {
        if (!this._avatarUpload) {
          const uploaded = await new Promise((resolve, reject) => wx.cloud.uploadFile({
            cloudPath: 'avatars/' + sync.genId() + '.png', filePath: avatarUrl, success: resolve, fail: reject
          }))
          if (!uploaded.fileID) throw new Error('头像上传失败，请重试')
          this._avatarUpload = uploaded.fileID
        }
        avatarUrl = this._avatarUpload
      }
      const p = await api.call('user', 'updateProfile', { nickname, avatarUrl }, { silent: true })
      if (avatarUrl && p.avatarUrl !== avatarUrl) throw new Error('云端api版本过旧，头像未保存。请重新部署api（云端安装依赖）后重试')
      if (p.nickname !== nickname) throw new Error('云端未确认资料保存，请稍后重试')
      const db = store.get()
      db.profile = Object.assign({}, db.profile, { nickname: p.nickname, avatarUrl: p.avatarUrl || '', accountAuthorized: p.accountAuthorized !== false })
      store.persist()
      this.render()
      this.setData({ accountShow: false })
      wx.showToast({ title: '资料已保存', icon: 'success' })
    } catch (e) { this.setData({ accountError: e.message || e.errMsg || '保存失败，请重试' }) }
    finally { this.setData({ accountBusy: false }) }
  },

  toggleTheme(e) {
    theme.set(e.detail.value ? 'dark' : 'light')
    this.setData({ theme: theme.get() })
  },

  // ---- 学习计划 ----
  onExam(e) {
    const examDate = e.detail.value
    const db = store.get()
    db.profile = Object.assign({}, db.profile, { examDate })
    store.persist()
    sync.enqueue('profile.update', { examDate })
    this.render()
  },

  onStart(e) {
    const startDate = e.detail.value
    const db = store.get()
    this.stagePlan({ startDate })
    this.setData({ startDate })
    this.render()
    this.askReplan('计划开始日已更新')
  },

  openWeek() {
    const db = store.get()
    const plan = db.planDraft || db.plan
    const tmpWeeks = (plan && plan.studyWeekdays) ? plan.studyWeekdays.slice() : [1, 2, 3, 4, 5, 6]
    this.setData({ sheet: 'week', tmpWeeks, weekSel: this.buildWeekSel(tmpWeeks) })
  },

  // WXML 表达式不支持 indexOf 等方法调用，选中态须在 JS 里算好
  buildWeekSel(tmpWeeks) {
    return WEEKS.map(w => ({ n: w.n, label: w.label, on: tmpWeeks.indexOf(w.n) >= 0 }))
  },

  toggleTmpWeek(e) {
    const n = Number(e.currentTarget.dataset.n)
    let ws = this.data.tmpWeeks.slice()
    const i = ws.indexOf(n)
    if (i >= 0) { if (ws.length === 1) return wx.showToast({ title: '至少保留一天', icon: 'none' }); ws.splice(i, 1) }
    else ws.push(n)
    ws.sort((a, b) => a - b)
    this.setData({ tmpWeeks: ws, weekSel: this.buildWeekSel(ws) })
  },

  saveWeek() {
    const db = store.get()
    this.stagePlan({ studyWeekdays: this.data.tmpWeeks })
    this.setData({ sheet: '' })
    this.render()
    this.askReplan('可学习日已更新')
  },

  /** 计划参数变化后，主动询问是否立即重新排期（保证首页今日/日历同步） */
  askReplan(title) {
    if (!store.get().plan && !store.get().planDraft) return
    wx.showModal({
      title: title,
      content: '是否立即重新排期？确认后将按新设置更新未来任务（历史与已完成不受影响）。',
      confirmText: '重新排期', cancelText: '稍后',
      success: (res) => { if (res.confirm) this.previewReplan() }
    })
  },

  openTpl() {
    const db = store.get()
    const plan = db.planDraft || db.plan
    const tpl = plan && plan.template && plan.template.length
      ? plan.template.map(t => Object.assign({}, t))
      : [{ subject: '阅读', content: '一篇真题', minutes: 40 }, { subject: '听力', content: '精听一篇', minutes: 40 }]
    this.setData({ sheet: 'tpl', tpl })
  },

  tplSub(e) { this.setData({ ['tpl[' + e.currentTarget.dataset.i + '].subject']: e.detail.value }) },
  tplCon(e) { this.setData({ ['tpl[' + e.currentTarget.dataset.i + '].content']: e.detail.value }) },
  tplMin(e) { this.setData({ ['tpl[' + e.currentTarget.dataset.i + '].minutes']: Math.max(5, Number(e.detail.value) || 30) }) },
  addTpl() { this.setData({ tpl: this.data.tpl.concat({ subject: '', content: '', minutes: 30 }) }) },
  delTpl(e) {
    const i = Number(e.currentTarget.dataset.i)
    const list = this.data.tpl.slice(); list.splice(i, 1)
    this.setData({ tpl: list })
  },

  async saveTpl() {
    if (this.data.saving) return
    const tpl = this.data.tpl.filter(t => t.subject && t.subject.trim()).map(t => Object.assign({}, t))
    if (!tpl.length) return wx.showToast({ title: '至少一个任务', icon: 'none' })
    if (!store.get().plan && !store.get().planDraft) return wx.showToast({ title: '请先创建学习计划', icon: 'none' })
    this.stagePlan({ template: tpl })
    const plan = JSON.parse(JSON.stringify(store.get().planDraft))
    this.setData({ saving: true, templateError: '' })
    wx.showLoading({ title: '更新任务中…', mask: true })
    try {
      await this.flushBeforePlan()
      const preview = await api.call('plan', 'previewReorder', { plan }, { silent: true })
      if (!preview || !Number.isInteger(preview.planVersion)) throw new Error('云函数版本不兼容，请重新部署 api（云端安装依赖）后重试')
      const result = await api.call('plan', 'confirmReorder', { plan, baseVersion: preview.planVersion }, { silent: true })
      this.applyScheduleResult(result)
      this.setData({ sheet: '' })
      wx.showToast({ title: '模板和任务已更新', icon: 'success' })
    } catch (e) {
      const message = e.code === 409 ? '计划已被修改，请再次保存；本次模板草稿已保留。' : (e.message || '更新失败，请重试')
      this.setData({ templateError: message + ' 本次修改已保留为草稿，尚未确认生效。' })
      wx.showModal({ title: '任务更新未完成', content: this.data.templateError, showCancel: false })
    } finally {
      wx.hideLoading()
      this.setData({ saving: false })
      this.render()
    }
  },

  closeSheet() { if (!this.data.saving) this.setData({ sheet: '' }) },
  noop() {},

  stagePlan(patch) {
    const db = store.get(), source = db.planDraft || db.plan
    if (!source) return
    db.planDraft = Object.assign({}, JSON.parse(JSON.stringify(source)), patch)
    store.persist()
  },

  async flushBeforePlan() {
    const result = await sync.flush()
    if (result.remain) throw new Error('还有未同步的改动，请先完成数据同步再调整计划')
  },

  applyScheduleResult(result) {
    if (!result || !result.plan || !(result.buckets && result.buckets.sessions || result.sessionsByDate)) throw new Error('云端未返回完整任务，无法确认更新结果。请重新部署 api（云端安装依赖）后刷新重试')
    const db = store.get()
    db.scheduleRevision = (db.scheduleRevision || 0) + 1
    if (result.buckets) result.buckets.scheduleRevision = db.scheduleRevision
    db.planDraft = null
    store.applyServerBuckets(result.buckets || { plan: result.plan, sessions: result.sessionsByDate || {} })
    this.render()
  },

  // ---- 预览重新排期 ----
  async previewReplan() {
    const db = store.get(), plan = db.planDraft || db.plan
    if (!plan) return this.createPlan()
    if (this.data.saving) return
    this.setData({ saving: true })
    try {
      await this.flushBeforePlan()
      const res = await api.call('plan', 'previewReorder', { plan })
      this._previewPlan = JSON.parse(JSON.stringify(plan))
      this.setData({ previewShow: true, preview: res })
    } catch (e) {
      wx.showToast({ title: e.message || '预览失败', icon: 'none' })
    } finally { this.setData({ saving: false }) }
  },

  cancelPreview() { this.setData({ previewShow: false, preview: null }); this._previewPlan = null },
  async confirmPreview() {
    if (this.data.saving || !this.data.preview || !this._previewPlan) return
    this.setData({ saving: true })
    try {
      await this.flushBeforePlan()
      const done = await api.call('plan', 'confirmReorder', {
        plan: this._previewPlan, baseVersion: this.data.preview.planVersion
      })
      this.applyScheduleResult(done)
      this.cancelPreview()
      wx.showToast({ title: '任务已更新', icon: 'success' })
    } catch (e) {
      if (e.code === 409) {
        this.cancelPreview()
        wx.showModal({ title: '计划已有变更', content: '请重新预览后确认，本地草稿已保留。', showCancel: false })
      } else wx.showToast({ title: e.message || '操作失败，草稿已保留', icon: 'none' })
    } finally { this.setData({ saving: false }); this.render() }
  },

  // ---- 导入任务计划（Excel） ----

  /** 从微信聊天记录选择 xlsx 文件（小程序选择本地文件的标准途径） */
  importExcel() {
    if (this.data.importing || this.data.saving) return
    this.setData({ importing: true, importError: '' })
    const fail = (err) => {
      this.setData({ importing: false })
      const detail = String(err && (err.errMsg || err.message) || '未知错误')
      if (/cancel/i.test(detail)) return
      let message = '无法选择文件，请重试或更新微信。'
        if (/scope is not declared|privacy agreement/i.test(detail)) {
          message = '小程序后台未声明文件选择用途。请管理员在微信公众平台“小程序 → 设置 → 用户隐私保护指引”中声明“选中的文件”，用途填写“读取用户选择的 Excel 文件，导入学习任务计划”，提交生效后重新预览。此错误不是你拒绝授权。'
        } else if (/privacy|authorize|auth deny|permission|隐私|授权/i.test(detail)) {
        message = '文件选择未获得隐私授权。请同意小程序隐私保护指引后重试；若仍失败，请检查小程序后台是否声明了文件选择相关隐私用途。'
      }
      this.setData({ importError: message + '（' + detail + '）' })
      wx.showModal({ title: '文件选择失败', content: this.data.importError, showCancel: false })
    }
    const choose = () => {
      try {
        if (typeof wx.chooseMessageFile !== 'function') throw new Error('当前微信不支持文件选择，请更新微信')
        wx.chooseMessageFile({
          count: 1, type: 'file', extension: ['xlsx'],
          fail,
          success: (res) => {
            const f = res.tempFiles && res.tempFiles[0]
            if (!f || !f.path) return fail({ errMsg: '未获得文件，请先把 .xlsx 文件发送到微信聊天，再重新选择' })
            const invalid = f.name && !/\.xlsx$/i.test(f.name) ? '仅支持 .xlsx 格式' : f.size > 2 * 1024 * 1024 ? '文件需小于 2MB' : ''
            if (invalid) {
              this.setData({ importing: false, importError: invalid })
              return wx.showToast({ title: invalid, icon: 'none' })
            }
            try {
              wx.getFileSystemManager().readFile({
                filePath: f.path,
                success: (r) => this.uploadImport(r.data),
                fail: () => {
                  this.setData({ importing: false, importError: '读取文件失败，请重新下载聊天中的文件后重试' })
                  wx.showModal({ title: '读取失败', content: this.data.importError, showCancel: false })
                }
              })
            } catch (err) { fail(err) }
          }
        })
      } catch (err) { fail(err) }
    }
    try {
      if (typeof wx.requirePrivacyAuthorize === 'function') wx.requirePrivacyAuthorize({ success: choose, fail })
      else choose()
    } catch (err) { fail(err) }
  },

  async uploadImport(buf) {
    wx.showLoading({ title: '解析中…', mask: true })
    try {
      const res = await api.call('data', 'importPreview', { fileBase64: wx.arrayBufferToBase64(buf) }, { silent: true })
      wx.hideLoading()
      if (!res.rows || !res.rows.length) return wx.showToast({ title: '未解析到任务', icon: 'none' })
      this.setData({ sheet: 'import', importPreview: res })
    } catch (e) {
      wx.hideLoading()
      this.setData({ importError: e.message || '解析失败，请重试' })
      wx.showModal({
        title: '解析失败',
        content: (e && e.message) || '请使用《学习计划导入模板.xlsx》填好后重试',
        showCancel: false
      })
    } finally { this.setData({ importing: false }) }
  },

  async confirmImport() {
    const pv = this.data.importPreview
    if (!pv || !pv.rows || !pv.rows.length || this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: '导入中…', mask: true })
    try {
      await this.flushBeforePlan()
      const res = await api.call('data', 'importApply', { rows: pv.rows, title: pv.imported && pv.imported.title, baseVersion: pv.planVersion })
      this.applyScheduleResult(res)
      wx.hideLoading()
      this.setData({ sheet: '', importPreview: null, saving: false })
      const st = res.imported || {}
      wx.showModal({
        title: '导入成功',
        content: '共 ' + (st.days || 0) + ' 天 / ' + (st.tasks || 0) + ' 个任务，今日与日历已更新。',
        showCancel: false
      })
      this.render()
    } catch (e) {
      wx.hideLoading()
      this.setData({ saving: false })
      wx.showToast({ title: (e && e.message) || '导入失败', icon: 'none' })
    }
  },

  cancelImport() { this.setData({ sheet: '', importPreview: null }) },

  /** 恢复初始状态：清空计划与学习数据（保留考试日期与习惯），云端同步清理 */
  resetPlan() {
    wx.showModal({
      title: '恢复初始状态？',
      content: '将清空学习计划、每日任务、学习记录与习惯打卡；考试日期与习惯定义保留。建议先导出备份。',
      confirmText: '恢复', confirmColor: '#B04A3A',
      success: async (r) => {
        if (!r.confirm) return
        try {
          await this.flushBeforePlan()
          await api.call('data', 'resetPlan', {})
          store.resetPlanData()
          wx.showToast({ title: '已恢复初始状态', icon: 'success' })
          this.render()
        } catch (e) { wx.showToast({ title: e.message || '恢复失败，数据已保留', icon: 'none' }) }
      }
    })
  },

  // ---- 偏好与数据 ----
  goHabits() { wx.navigateTo({ url: '/pages/habits/index' }) },

  /**
   * 新建计划：本地先落一份（离线可用），再交给服务端生成正式排期
   * 服务端确认后以服务端版本为准覆盖本地
   */
  async createPlan() {
    if (this.data.saving) return
    this.setData({ saving: true })
    const today = d.todayStr()
    const draft = store.get().planDraft || {
      _id: 'local_plan_' + Date.now().toString(36),
      version: 0,
      title: '我的学习计划',
      startDate: today,
      studyWeekdays: [1, 2, 3, 4, 5, 6],
      extraRestDates: [],
      dailyMaxSessions: 6,
      template: [
        { subject: '阅读', content: '一篇真题', minutes: 45 },
        { subject: '听力', content: '精听一篇', minutes: 40 },
        { subject: '单词', content: '复习+新词', minutes: 30 }
      ]
    }
    store.get().planDraft = draft
    store.persist()
    this.render()
    wx.showLoading({ title: '生成排期中…', mask: true })
    try {
      await this.flushBeforePlan()
      const res = await api.call('plan', 'confirmReorder', { plan: draft, baseVersion: 0 })
      this.applyScheduleResult(res)
      wx.hideLoading()
      wx.showToast({ title: '计划已创建', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.code === 409 ? '已有计划，请重新预览' : '草稿已保存，联网后请重试排期', icon: 'none' })
    }
    this.setData({ saving: false })
    this.render()
  },

  /** 未创建计划时的引导入口 */
  initPlan() { this.createPlan() },

  async syncNow() {
    wx.showLoading({ title: '同步中…', mask: true })
    try {
      const flushed = await sync.flush()
      if (flushed.remain) throw new Error('仍有 ' + flushed.remain + ' 条改动待同步')
      const to = d.todayStr(), from = d.addDays(to, -75)
      const res = await api.call('plan', 'getRange', { from, to }, {})
      store.applyServerBuckets(res.buckets)
      try {
        const h = await api.call('habit', 'listAll', {}, { silent: true })
        if (h.habits) store.applyServerBuckets({ habits: h.habits })
      } catch (e) { /* 忽略 */ }
      wx.hideLoading()
      wx.showToast({ title: '已同步', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.message || '网络异常，稍后重试', icon: 'none' })
    }
    this.render()
  },

  async exportData() {
    if (this.data.exporting || this.data.downloading) return
    this.setData({ exporting: true, exportError: '', exportFile: null })
    const owner = store.get()
    try {
      const synced = await sync.flush()
      if (synced.remain) throw new Error('还有未同步的学习记录，请先完成数据同步后再导出')
      const res = await api.call('data', 'exportExcel', {}, { silent: true })
      if (!res.fileID || !res.fileName) throw new Error('导出接口未更新，请重新部署 api（云端安装依赖）')
      if (store.get() !== owner) return
      this._exportOwner = owner
      this._exportPath = ''
      this.setData({ exportFile: res })
    } catch (e) {
      this.setData({ exportError: e.code === 404 ? '请重新部署 api（云端安装依赖）后再导出' : e.message || '导出失败，请联网后重试' })
    } finally { this.setData({ exporting: false }) }
  },

  async downloadExport() {
    const file = this.data.exportFile
    if (!file || this.data.downloading || this._exportOwner !== store.get()) return
    this.setData({ downloading: true, exportError: '' })
    try {
      if (!this._exportPath) {
        const downloaded = await new Promise((resolve,reject) => wx.cloud.downloadFile({ fileID:file.fileID, success:resolve, fail:reject }))
        const path = wx.env.USER_DATA_PATH + '/' + file.fileName
        await new Promise((resolve,reject) => wx.getFileSystemManager().copyFile({ srcPath:downloaded.tempFilePath, destPath:path, success:resolve, fail:reject }))
        this._exportPath = path
      }
      await new Promise((resolve,reject) => wx.openDocument({ filePath:this._exportPath, fileType:'xlsx', showMenu:true, success:resolve, fail:reject }))
    } catch (e) {
      this._exportPath = ''
      this.setData({ exportError:'下载或打开失败，请重试。' + (e.errMsg || e.message || '') })
    } finally { this.setData({ downloading: false }) }
  },

  deleteAll() {
    wx.showModal({
      title: '删除全部云端数据？',
      content: '将删除计划、记录、习惯与打卡数据，且无法恢复。建议先导出备份。',
      confirmText: '继续', confirmColor: '#B04A3A',
      success: (res) => {
        if (!res.confirm) return
        wx.showModal({
          title: '再次确认', content: '真的要删除全部数据吗？此操作不可撤销。',
          confirmText: '删除', confirmColor: '#B04A3A',
          success: async (r2) => {
            if (!r2.confirm) return
            try {
              await this.flushBeforePlan()
              await api.call('data', 'requestDeletion', {})
              store.reset()
              getApp().globalData.profile = null
              getApp().login()
              wx.showToast({ title: '已删除', icon: 'success' })
              this.render()
            } catch (e) {
              wx.showToast({ title: '操作失败（需联网）', icon: 'none' })
            }
          }
        })
      }
    })
  }
})
