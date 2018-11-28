const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

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
    console.log('pdf', pdfList)
  } catch(e) {
    log('warn', e)
    log('warn', 'Impossible to fetch pdfs, option may be not activated')
  }

  log('info', 'Fetching page of refunds list')
  const $ = await request(`${baseUrl}/ma_sante_et_mes_demarches/mes_remboursements/liste_des_remboursements`)

  log('info', 'Parsing list of refunds')
  const bills = await parseBills($, pdfList)

  console.log(bills)
  log('info', 'Saving data to Cozy')
  await saveBills(bills, fields, {
    identifiers: ['todoeovimcd'] //TODO  FOUND IDENTIFIERS
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

function parseBills($, pdfList) {
  const bills = []
  // Forced to use collapsed class of this tr because ligne-titre is in sub table
  $('tbody tr[class="ligne-titre collapsed"]').each((index, el) => {
    log('info', `Found master line number ${index}`)
    // Verify next tr is a line with sub bills
    if($(el).next('tr').hasClass('ligne-detail') !== true) {
      log('error', "Next tr hasn't ligne-detail class, will break everything")
      throw new Error('NOT_IMPLEMENTED')
    }
    const date = parseDate($(el).find('td[class="date"]').text())
    const amount = normalizePrice($(el).find('td[class="mutuelle"]').text())
    const htmlUrl = baseUrl + $(el).next('tr').find('a[title="Imprimer"]').attr('href')
    const id = htmlUrl.match(/\d*?$/)[0]
    // If a pdf matchin by id is found, set it as fileurl else generate a pdf from html
    const matchingPdf = pdfList.find(obj => obj.id === id)
    let fileurl = ''
    if (matchingPdf) {
      log('info', 'Found matching this masterline with a pdf')
      fileurl = matchingPdf.fileurl
    } else {
      log('info', 'No pdf match this line, generating one myself')
      //generate
    }
    console.log('htmlurl', htmlUrl)
    console.log($(el).html())

    // Scrape each sub bill
    $(el).next('tr').find('tbody tr[class="ligne-titre"]').each((subIndex, subEl) => {
      let bill = parseSubline($, subEl)
      log('info', `Found subline number ${subIndex} of master ${index}`)
      console.log($(subEl).html())
      bill = {
        ...bill,
        vendor: 'EoviMCD',
        type: 'health_costs',
        currency: '€',
        isRefund: true,
        isThirdPartyPayer: false,
        filename: formatDate(date) + `_${amount}€_EoviMCD.pdf`,
        fileurl,
        date,
        amount
      }
      bills.push(bill)
    })


  })
  return bills
}

function parseSubline($, subEl) {
  const originalDate = parseDate($(subEl).find('td[data-column-header="Date"]').text())
  const beneficiary = $(subEl).find('td[data-column-header="Pour"]').text()
  const originalAmount = normalizePrice($(subEl).find('td[data-column-header="Mutuelle"]').text())
  const socialSecurityRefund = normalizePrice(
    $(subEl).find('td[data-column-header="Sécurité Sociale"]').text())
  //TODO can scrape subtype, with medical infos
  return {
    originalDate,
    beneficiary,
    originalAmount,
    socialSecurityRefund
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

// Convert a price string to a float
function normalizePrice(price) {
  return parseFloat(price.replace('€', '').replace(',','.').trim())
}

// Convert a french date to Date object
function parseDate(text) {
  const [d, m, y] = text.split('/', 3).map(e => parseInt(e, 10))
  return new Date(y, m - 1, d)
}

// Convert a Date object to a french date string
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
