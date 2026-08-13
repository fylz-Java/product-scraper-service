const express = require('express')
const { chromium: playwrightChromium } = require('playwright-core')
const chromium = require('@sparticuz/chromium')

const app = express()
app.use(express.json({ limit: '5mb' }))

const PORT = process.env.PORT || 3000
const API_KEY = process.env.API_KEY || 'your-secret-api-key'

// 平台识别
function detectPlatform(url) {
  const lower = url.toLowerCase()
  const map = {
    'taobao.com': '淘宝', 'tmall.com': '天猫', 'tb.cn': '淘宝',
    'jd.com': '京东', '3.cn': '京东', 'jd.hk': '京东',
    'pinduoduo.com': '拼多多', 'yangkeduo.com': '拼多多', 'pdd.com': '拼多多',
    'suning.com': '苏宁', 'vip.com': '唯品会',
    'douyin.com': '抖音', 'v.douyin.com': '抖音',
    'xiaohongshu.com': '小红书', 'xhslink.com': '小红书'
  }
  for (const [domain, name] of Object.entries(map)) {
    if (lower.includes(domain)) return name
  }
  return '网购平台'
}

// 从京东 URL 提取 SKU
function extractJdSku(url) {
  const patterns = [
    /\/sku\/(\d+)/i,
    /\/(\d{6,})\.html/i,
    /skuId[=\/](\d+)/i,
    /\/(\d{10,})/i
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

// 从淘宝 URL 提取 itemId
function extractTbItemId(url) {
  const patterns = [
    /[?&]id=(\d+)/,
    /\/item\/(\d+)/,
    /\/(\d{10,})\.htm/
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

// 等待页面稳定
async function waitForStable(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 })
  } catch (e) {
    // ignore
  }
  // 再等待一下动态内容
  await page.waitForTimeout(2000)
}

// 智能提取商品信息
async function extractProductInfo(page, url) {
  const platform = detectPlatform(url)
  const skuId = extractJdSku(url)
  const itemId = extractTbItemId(url)

  const result = await page.evaluate(({ platform, skuId, itemId }) => {
    const data = {
      title: '',
      description: '',
      price: '',
      originalPrice: '',
      images: [],
      specs: '',
      platform,
      skuId,
      itemId
    }

    // 通用 title
    const titleEl = document.querySelector('title')
    if (titleEl) data.title = titleEl.innerText.trim()

    // 通用 meta description
    const descMeta = document.querySelector('meta[name="description"]')
    if (descMeta) data.description = descMeta.content || ''

    // 通用 og:title
    const ogTitle = document.querySelector('meta[property="og:title"]')
    if (ogTitle && ogTitle.content) data.title = ogTitle.content.trim()

    // 通用 og:description
    const ogDesc = document.querySelector('meta[property="og:description"]')
    if (ogDesc && ogDesc.content) data.description = ogDesc.content.trim()

    // 通用 og:image
    const ogImage = document.querySelector('meta[property="og:image"]')
    if (ogImage && ogImage.content) data.images.push(ogImage.content)

    // === 京东 ===
    if (platform === '京东') {
      // 商品名
      const jdName = document.querySelector('.sku-name') || document.querySelector('#sku-name')
      if (jdName) data.title = jdName.innerText.trim()

      // 价格
      const jdPrice = document.querySelector('.price-now .p-price .price') ||
                      document.querySelector('.p-price .price') ||
                      document.querySelector('[class*="price"]')?.innerText.match(/\d+\.?\d*/)?.[0]
      if (jdPrice) data.price = typeof jdPrice === 'string' ? jdPrice : jdPrice.innerText.trim()

      // 规格参数
      const specItems = document.querySelectorAll('#detail .Ptable-item, .parameter2 li, .Ptable-item')
      if (specItems.length > 0) {
        data.specs = Array.from(specItems).slice(0, 20).map(el => el.innerText.trim()).join('，')
      }
    }

    // === 淘宝/天猫 ===
    if (platform === '淘宝' || platform === '天猫') {
      const tbName = document.querySelector('h1[data-spm="title"]') ||
                     document.querySelector('.tb-detail-hd h1') ||
                     document.querySelector('h1')
      if (tbName) data.title = tbName.innerText.trim()

      const tbPrice = document.querySelector('.tb-rmb-num') ||
                      document.querySelector('.notranslate') ||
                      document.querySelector('[class*="price"]')
      if (tbPrice) data.price = tbPrice.innerText.trim()
    }

    // === 拼多多 ===
    if (platform === '拼多多') {
      const pddName = document.querySelector('[data-testid="goods-title"]') ||
                      document.querySelector('.goods-title')
      if (pddName) data.title = pddName.innerText.trim()

      const pddPrice = document.querySelector('[data-testid="current-price"]') ||
                       document.querySelector('.goods-price .current')
      if (pddPrice) data.price = pddPrice.innerText.trim()
    }

    // 清理 title
    data.title = data.title
      .replace(/\s*[-_|]\s*(淘宝|天猫|京东|拼多多|苏宁易购|唯品会|抖音|小红书).*/, '')
      .replace(/\s*[-–]\s*(淘宝网|京东商城|拼多多|小红书).*/, '')
      .trim()

    // 价格清理
    if (data.price) {
      const priceMatch = data.price.match(/(\d+(?:,\d+)*\.?\d*)/)
      if (priceMatch) data.price = priceMatch[1].replace(/,/g, '')
    }

    return data
  }, { platform, skuId, itemId })

  return result
}

// 主爬虫逻辑
async function scrapeProduct(url) {
  let browser = null
  try {
    browser = await playwrightChromium.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1280,720'
      ],
      executablePath: await chromium.executablePath(),
      headless: true
    })

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai'
    })

    const page = await context.newPage()

    // 拦截图片/字体/CSS 加速加载（可选）
    await page.route(/\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|css)$/, route => route.abort())

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })

    await waitForStable(page)

    // 如果页面是验证页，尝试滚动触发
    const title = await page.title()
    if (title.includes('验证') || title.includes('登录') || title.includes('captcha')) {
      throw new Error('页面需要验证或登录')
    }

    const info = await extractProductInfo(page, url)
    info.finalUrl = page.url()

    return {
      success: true,
      data: info
    }
  } catch (e) {
    console.error('Scrape error:', e)
    return {
      success: false,
      error: e.message
    }
  } finally {
    if (browser) await browser.close()
  }
}

// API Key 校验中间件
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key
  if (key !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Unauthorized' })
  }
  next()
}

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// 爬虫接口
app.post('/scrape', authMiddleware, async (req, res) => {
  const { url } = req.body
  if (!url || !url.startsWith('http')) {
    return res.status(400).json({ success: false, error: 'Invalid URL' })
  }

  console.log('Scraping:', url)
  const result = await scrapeProduct(url)
  res.json(result)
})

app.listen(PORT, () => {
  console.log(`Scraper service running on port ${PORT}`)
  console.log(`API_KEY loaded: ${API_KEY ? API_KEY.slice(0, 4) + '****' : 'NOT SET'}`)
})
