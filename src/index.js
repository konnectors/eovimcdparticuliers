const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log,
  htmlToPDF,
  createCozyPDFDocument
} = require('cozy-konnector-libs')

const cheerio = require('cheerio')
const request = requestFactory({
//  debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const baseUrl = 'https://www.espace-particuliers.eovi-mcd-mutuelle.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Trying to fetch pdf list if available')
  const $pdf = await request(`${baseUrl}/ma_sante_et_mes_demarches/mes_remboursements/`
                             + 'releve_de_prestations')
  let pdfList = []
  try {
    pdfList = scrapePdfList($pdf)
    log('info', `Found ${pdfList.length} pdfs, expect as many masterline`)
  } catch(e) {
    log('warn', e)
    log('warn', 'Impossible to fetch pdfs, option may be not activated')
  }

  log('info', 'Fetching page of refunds list')
  const $ = await request(`${baseUrl}/ma_sante_et_mes_demarches/mes_remboursements/liste_des_remboursements`)

  log('info', 'Parsing list of refunds')
  const bills = await parseBills($, pdfList)
  log('info', `${bills.length} bills generated`)

  log('info', 'Saving data to Cozy')
  await saveBills(bills, fields, {
    identifiers: ['EOVI MCD MUTUELLE']
  })
}

function authenticate(username, password) {
  return signin({
    url: `${baseUrl}/login`,
    formSelector: 'form',
    formData: { _username: username, _password: password },
    validate: (statusCode, $, fullResponse) => {
      log('debug', 'Redirecting to', fullResponse.request.uri.href)
      if (fullResponse.request.uri.href === `${baseUrl}/login`) {
        log('error', 'Auth redirect to login page, LOGIN_FAILED detected')
        return false
      } else {
        return true
      }
    }
  })
}

async function parseBills($, pdfList) {
  const bills = []
  // Forced to use collapsed class of this tr because ligne-titre is in sub table
  const masters = Array.from($('tbody tr[class="ligne-titre collapsed"]'))
  for (let index=0; index<masters.length; index++) {
    const el = masters[index]
    log('info', `Found master line number ${index}`)
    // Verify next tr is a line with sub bills
    if ($(el).next('tr').hasClass('ligne-detail') !== true) {
      log('error', "Next tr hasn't ligne-detail class, will break everything")
      throw new Error('NOT_IMPLEMENTED')
    }
    const date = parseDate($(el).find('td[class="date"]').text())
    const masterAmount = normalizePrice($(el).find('td[class="depense hidden-xs"]').text())
    const masterSocialSecuAmount = normalizePrice(
      $(el).find('td[class="secu hidden-xs"]').text())
    const groupAmount = normalizePrice($(el).find('td[class="mutuelle"]').text())
    const htmlUrl = baseUrl + $(el).next('tr').find('a[title="Imprimer"]').attr('href')
    const id = htmlUrl.match(/\d*?$/)[0]

    // Scrape Metadatas of each sub bill
    const subs = Array.from($(el).next('tr').find('tbody tr[class="ligne-titre"]'))
    const subsLinesMetadatas = []
    for (subIndex=0; subIndex<subs.length; subIndex++) {
      subsLinesMetadatas.push(parseSubline($, subs[subIndex]))
      log('info', `Found subline number ${subIndex} of master ${index}`)
    }

    // If a pdf matching by id is found, set it as fileurl else generate a pdf from html
    const matchingPdf = pdfList.find(obj => obj.id === id)
    let fileurl = ''
    let filestream = null
    if (matchingPdf) {
      log('info', 'Found matching this masterline with a pdf')
      fileurl = matchingPdf.fileurl
    } else {
      log('info', 'No pdf match this  masterline, generating one myself')
      const $htmlToPdf = generateHtmlPdf(formatFrenchDate(date),
                                         masterAmount,
                                         masterSocialSecuAmount,
                                         groupAmount,
                                         subsLinesMetadatas
                                        )
      filestream = generatePDF($htmlToPdf, htmlUrl)
    }

    // Create bill for each subline
    for (let sub of subsLinesMetadatas) {
      let bill = {
        originalDate: sub.originalDate,
        beneficiary: sub.beneficiary,
        subtype: sub.subtype,
        originalAmount: sub.originalAmount,
        socialSecurityRefund: sub.socialSecurityRefund,
        amount: sub.amount,
        vendor: 'EoviMCD',
        type: 'health_costs',
        currency: '€',
        isRefund: true,
        isThirdPartyPayer: false,
        filename: formatDate(date) + `_${groupAmount}€_EoviMCD.pdf`,
        date,
        groupAmount
      }
      if (fileurl !== '') {
        bill.fileurl = fileurl
      } else {
        bill.filestream = filestream
      }
      bills.push(bill)
    }
  }
  return bills
}

function parseSubline($, subEl) {
  const originalDate = parseDate($(subEl).find('td[data-column-header="Date"]').text())
  const beneficiary = $(subEl).find('td[data-column-header="Pour"]').text()
  const subtype = $(subEl).find('td[data-column-header="Nature"]').text()
  const originalAmount = normalizePrice(
      $(subEl).find('td[data-column-header="Dépense"]').text())
  const socialSecurityRefund = normalizePrice(
    $(subEl).find('td[data-column-header="Sécurité Sociale"]').text())
  const amount = normalizePrice(
    $(subEl).find('td[data-column-header="Mutuelle"]').text())

  return {
    originalDate,
    beneficiary,
    subtype,
    originalAmount,
    socialSecurityRefund,
    amount
  }
}

function scrapePdfList($) {
  const pdfs = []
  $('ul[class="documents"] a[class="pdf"]').each((index, el) => {
    const fileurl = $(el).attr('href')
    const date = parseDate($(el).text().trim())
    const id = fileurl.match(/\/(\d*?)\//)[1]
    pdfs.push({
      fileurl: `${baseUrl}${fileurl}`,
      date,
      id
    })
  })
  return pdfs
}

function generatePDF($, url) {
  let doc = createCozyPDFDocument(
    'Généré automatiquement par le connecteur Eovi MCD Mutuelle',
    '' // empty url
  )
  htmlToPDF($, doc, $('body'),
            {baseURL: 'https://www.espace-particuliers.eovi-mcd-mutuelle.fr/'})
  doc.end()
  return doc
}

// Convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace('€', '').replace(',','.').trim())
}

// Convert a french date to Date object
function parseDate(text) {
  const [d, m, y] = text.split('/', 3).map(e => parseInt(e, 10))
  return new Date(y, m - 1, d)
}

// Convert a Date object to a ISO date string
function formatDate(date) {
  let year = date.getFullYear()
  let month = date.getMonth() + 1
  let day = date.getDate()
  if (month < 10) {
    month = '0' + month
  }
  if (day < 10) {
    day = '0' + day
  }
  return `${year}-${month}-${day}`
}

// Convert a Date object to a french date string
function formatFrenchDate(date) {
  let year = date.getFullYear()
  let month = date.getMonth() + 1
  let day = date.getDate()
  if (month < 10) {
    month = '0' + month
  }
  if (day < 10) {
    day = '0' + day
  }
  return `${day}/${month}/${year}`
}

function generateHtmlPdf(niceDate, masterAmount, masterSocialSecuAmount,
                         groupAmount, subsLinesMetadatas) {
  let htmlPdf = '<body>'
  // First table section
  htmlPdf += `<p><b>Votre remboursement du ${niceDate} :\n&nbsp</b></p>`
  htmlPdf += '<table style="width:10px">' //dummy mandatory width
  htmlPdf += '<tr><th><b>Date</b></th><th><b>Dépense totale</b></th><th><b>Remboursement Sécu</b></th><th><b>Remboursement Mutuelle</b></th></tr>'
  htmlPdf += `<tr><th>${niceDate}</th><th>${masterAmount} €</th><th>${masterSocialSecuAmount} €</th><th>${groupAmount} €</th></tr>`
  htmlPdf += '</table>'
  // Second table section
  htmlPdf += '<p><b>&nbsp\nDétail des soins :\n&nbsp</b></p>'
  htmlPdf += '<table style="width:10px">' //dummy mandatory width
  htmlPdf += '<tr><th><b>Date</b></th><th><b>Nature</b></th><th><b>Dépense totale</b></th><th><b>Remboursement Sécu</b></th><th><b>Remboursement Mutuelle</b></th></tr>'
  for (let sub of subsLinesMetadatas) {
    const niceOriginalDate = formatFrenchDate(sub.originalDate)
    htmlPdf += `<tr><th>${niceOriginalDate}</th><th>${sub.subtype}</th><th>${sub.originalAmount} €</th><th>${sub.socialSecurityRefund} €</th><th>${sub.amount} €</th></tr>`
  }
  htmlPdf += '</table>'
  // Third section
  htmlPdf += '<p><b>&nbsp\nObtenez le document original Eovi-MCD</b></p>'
  htmlPdf += '<p>&nbsp\nPour obtenir le document original Eovi-MCD, vous devez activer le relevé de prestations numériques sur votre espace personnel Eovi-MCD.\n</p>'
  htmlPdf += '<p>&nbsp\nDans votre espace allez dans "Ma santé et mes démarches", "Relevés de prestations" et activez les relevés de prestations numériques.\n</p>'
  htmlPdf += '<p>&nbsp\nUne fois activé, vous pouvez supprimer les pdfs Eovi-MCD de votre cozy, ils seront remplacés par les originaux au prochain lancement du connecteur.</p>'
  htmlPdf += '<p>&nbsp\nPour vous connecter :\n&nbsp<a href="/login">https://www.espace-particuliers.eovi-mcd-mutuelle.fr/login</a></p>'
  htmlPdf += '</body>'

  return cheerio.load(htmlPdf)
}
