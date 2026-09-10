#!/usr/bin/env node

/**
 * Script Validasi & Analisis Data Kartu (BIN / Card Checker & Metadata Analyzer)
 * Path: scripts/validate-education-cards.js
 *
 * Fitur:
 * 1. Luhn Algorithm (Mod 10 Check)
 * 2. Expiration Date Check (MM/YY vs tanggal sistem)
 * 3. Card Scheme & Brand Detection (Visa, Mastercard, Amex, Discover, etc.)
 * 4. Deduplikasi data
 * 5. Multi-Source BIN Metadata Lookup (Issuer Bank, Card Type: Debit/Credit/Prepaid, Country, Tier)
 * 6. Ekspor hasil bersih (.txt) & Laporan detail (.json)
 * 7. (Opsional) Stripe Sandbox / Test Mode Pre-auth Checker
 *
 * Penggunaan:
 *   node scripts/validate-education-cards.js
 *   node scripts/validate-education-cards.js --bin-lookup
 *   node scripts/validate-education-cards.js --input docs/education.txt --output docs/education_valid.txt --json-report docs/education_report.json
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

// ANSI Color Helpers
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
};

/**
 * 1. Luhn Algorithm Check (Mod 10)
 */
function isValidLuhn(cardNumber) {
  const digits = cardNumber.replace(/\D/g, '');
  if (!digits || digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits.charAt(i), 10);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

/**
 * 2. Expiration Date Check
 */
function isDateValid(monthStr, yearStr) {
  const month = parseInt(monthStr, 10);
  let year = parseInt(yearStr, 10);

  if (isNaN(month) || isNaN(year) || month < 1 || month > 12) {
    return { valid: false, reason: 'Format bulan tidak valid (1-12)' };
  }

  // Handle 2-digit vs 4-digit year
  if (yearStr.length === 2) {
    year += 2000;
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (year < currentYear || (year === currentYear && month < currentMonth)) {
    return { valid: false, reason: `Sudah Kedaluwarsa (${month.toString().padStart(2, '0')}/${year})` };
  }

  return { valid: true, formattedExpiry: `${month.toString().padStart(2, '0')}/${year}` };
}

/**
 * 3. Identifikasi Skema / Brand Kartu & Validasi CVV/Panjang
 */
function identifyCardBrand(cardNumber) {
  const cleanNum = cardNumber.replace(/\D/g, '');

  if (/^4[0-9]{12}(?:[0-9]{3})?$/.test(cleanNum)) {
    return { brand: 'VISA', validLength: cleanNum.length === 16 || cleanNum.length === 13, expectedCvvLength: 3 };
  }
  if (/^(?:5[1-5][0-9]{14}|2(?:22[1-9]|2[3-9][0-9]|[3-6][0-9]{2}|7[0-1][0-9]|720)[0-9]{12})$/.test(cleanNum)) {
    return { brand: 'MASTERCARD', validLength: cleanNum.length === 16, expectedCvvLength: 3 };
  }
  if (/^3[47][0-9]{13}$/.test(cleanNum)) {
    return { brand: 'AMEX', validLength: cleanNum.length === 15, expectedCvvLength: 4 };
  }
  if (/^6(?:011|5[0-9]{2}|4[4-9][0-9]|22(?:12[6-9]|1[3-9][0-9]|[2-8][0-9]{2}|9[01][0-9]|92[0-5]))[0-9]{12}$/.test(cleanNum)) {
    return { brand: 'DISCOVER', validLength: cleanNum.length === 16, expectedCvvLength: 3 };
  }
  if (/^(?:2131|1800|35\d{3})\d{11}$/.test(cleanNum)) {
    return { brand: 'JCB', validLength: cleanNum.length === 16, expectedCvvLength: 3 };
  }
  if (/^3(?:0[0-5]|[68][0-9])[0-9]{11}$/.test(cleanNum)) {
    return { brand: 'DINERS', validLength: cleanNum.length === 14, expectedCvvLength: 3 };
  }

  return { brand: 'UNKNOWN', validLength: cleanNum.length >= 13 && cleanNum.length <= 19, expectedCvvLength: 3 };
}

/**
 * 4. Multi-Source BIN Metadata Lookup
 */
async function lookupBin(bin6) {
  const cleanBin = bin6.replace(/\D/g, '').slice(0, 6);

  // Provider 1: HandyAPI
  try {
    const res = await fetch(`https://data.handyapi.com/bin/${cleanBin}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.Status === 'SUCCESS') {
        return {
          bin: cleanBin,
          scheme: data.Scheme || 'UNKNOWN',
          type: data.Type || 'UNKNOWN',
          tier: data.CardTier || 'N/A',
          issuer: data.Issuer || 'N/A',
          country: data.Country ? data.Country.Name : 'N/A',
          countryCode: data.Country ? data.Country.A2 : 'N/A',
        };
      }
    }
  } catch (_) {}

  // Provider 2: Binlist.net fallback
  try {
    const res = await fetch(`https://lookup.binlist.net/${cleanBin}`, {
      signal: AbortSignal.timeout(4000),
      headers: { 'Accept-Version': '3', 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.ok) {
      const data = await res.json();
      return {
        bin: cleanBin,
        scheme: data.scheme ? data.scheme.toUpperCase() : 'UNKNOWN',
        type: data.type ? data.type.toUpperCase() : 'UNKNOWN',
        tier: data.brand || 'N/A',
        issuer: data.bank ? data.bank.name : 'N/A',
        country: data.country ? data.country.name : 'N/A',
        countryCode: data.country ? data.country.alpha2 : 'N/A',
      };
    }
  } catch (_) {}

  return null;
}

/**
 * Main Processor
 */
async function processValidation() {
  const args = process.argv.slice(2);
  const inputArgIndex = args.indexOf('--input');
  const outputArgIndex = args.indexOf('--output');
  const jsonReportIndex = args.indexOf('--json-report');
  const doBinLookup = args.includes('--bin-lookup');

  const inputFile = inputArgIndex !== -1 && args[inputArgIndex + 1]
    ? path.resolve(args[inputArgIndex + 1])
    : path.resolve(ROOT_DIR, 'docs/education.txt');

  const outputFile = outputArgIndex !== -1 && args[outputArgIndex + 1]
    ? path.resolve(args[outputArgIndex + 1])
    : path.resolve(ROOT_DIR, 'docs/education_valid.txt');

  const jsonReportFile = jsonReportIndex !== -1 && args[jsonReportIndex + 1]
    ? path.resolve(args[jsonReportIndex + 1])
    : path.resolve(ROOT_DIR, 'docs/education_report.json');

  console.log(`\n${colors.bright}${colors.cyan}====================================================${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}    CARD VALIDATION & BIN ANALYZER TOOL (JS)       ${colors.reset}`);
  console.log(`${colors.bright}${colors.cyan}====================================================${colors.reset}\n`);

  if (!fs.existsSync(inputFile)) {
    console.error(`${colors.red}❌ File input tidak ditemukan: ${inputFile}${colors.reset}`);
    process.exit(1);
  }

  const rawContent = fs.readFileSync(inputFile, 'utf-8');
  const lines = rawContent.split(/\r?\n/);

  console.log(`📂 Membaca file       : ${colors.yellow}${inputFile}${colors.reset}`);
  console.log(`📊 Total baris di file : ${lines.length}`);
  if (doBinLookup) {
    console.log(`🌐 Mode BIN Lookup    : ${colors.green}AKTIF (Online Metadata Analysis)${colors.reset}`);
  } else {
    console.log(`⚡ Mode BIN Lookup    : ${colors.dim}OFF (Gunakan flag --bin-lookup untuk mengaktifkan)${colors.reset}`);
  }
  console.log();

  const seenCards = new Set();
  const validCards = [];
  const invalidCards = [];
  const brandCounts = {};
  const binMap = new Map();

  let duplicateCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split('|');
    if (parts.length < 4) {
      invalidCards.push({
        lineNo: i + 1,
        raw: line,
        reason: `Format kolom kurang (membutuhkan PAN|MM|YY|CVV, didapat ${parts.length} bagian)`,
      });
      continue;
    }

    const pan = parts[0].trim().replace(/\s+/g, '');
    const mm = parts[1].trim();
    const yy = parts[2].trim();
    const cvv = parts[3].trim();
    const extra = parts.slice(4).join('|');

    const cardKey = `${pan}|${mm}|${yy}|${cvv}`;

    // 1. Check Duplikat
    if (seenCards.has(cardKey)) {
      duplicateCount++;
      invalidCards.push({
        lineNo: i + 1,
        raw: line,
        reason: 'Duplikat (nomor kartu dan expiry sudah ada)',
      });
      continue;
    }
    seenCards.add(cardKey);

    // 2. Card Brand & Format
    const brandInfo = identifyCardBrand(pan);
    brandCounts[brandInfo.brand] = (brandCounts[brandInfo.brand] || 0) + 1;

    // 3. Expiry Check
    const expiryCheck = isDateValid(mm, yy);
    if (!expiryCheck.valid) {
      invalidCards.push({
        lineNo: i + 1,
        raw: line,
        pan,
        brand: brandInfo.brand,
        reason: expiryCheck.reason,
      });
      continue;
    }

    // 4. Luhn Checksum Check
    if (!isValidLuhn(pan)) {
      invalidCards.push({
        lineNo: i + 1,
        raw: line,
        pan,
        brand: brandInfo.brand,
        reason: 'Gagal Luhn Checksum (Nomor kartu matematis tidak valid)',
      });
      continue;
    }

    // 5. CVV Length check
    if (cvv.length < 3 || cvv.length > 4) {
      invalidCards.push({
        lineNo: i + 1,
        raw: line,
        pan,
        brand: brandInfo.brand,
        reason: `Panjang CVV tidak standar (${cvv.length} digit)`,
      });
      continue;
    }

    const bin6 = pan.slice(0, 6);
    if (!binMap.has(bin6)) {
      binMap.set(bin6, []);
    }

    const cardObj = {
      lineNo: i + 1,
      raw: line,
      pan,
      bin: bin6,
      mm,
      yy,
      cvv,
      extra,
      brand: brandInfo.brand,
      cleanLine: `${pan}|${mm}|${yy}|${cvv}${extra ? '|' + extra : ''}`,
    };

    validCards.push(cardObj);
    binMap.get(bin6).push(cardObj);
  }

  // BIN Metadata Analysis (jika diaktifkan)
  const binMetadataMap = new Map();
  if (doBinLookup && binMap.size > 0) {
    console.log(`${colors.cyan}🔍 Menganalisis ${binMap.size} grup BIN unik secara online...${colors.reset}`);
    const binKeys = Array.from(binMap.keys());

    for (let j = 0; j < binKeys.length; j++) {
      const binKey = binKeys[j];
      process.stdout.write(`  [${j + 1}/${binKeys.length}] BIN ${binKey} (${binMap.get(binKey).length} kartu)... `);

      const meta = await lookupBin(binKey);
      if (meta) {
        binMetadataMap.set(binKey, meta);
        console.log(`${colors.green}✓ ${meta.scheme} | ${meta.type} | ${meta.issuer} (${meta.country})${colors.reset}`);
      } else {
        console.log(`${colors.dim}- (Tidak ada info)${colors.reset}`);
      }

      // Throttle agar ramah ke API publik
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log();
  }

  // Tampilkan Hasil Validasi
  console.log(`${colors.bright}📋 RINGKASAN HASIL VALIDASI:${colors.reset}`);
  console.log(`----------------------------------------------------`);
  console.log(`Total Baris Diproses  : ${lines.filter((l) => l.trim()).length}`);
  console.log(`Total Kartu Unik      : ${seenCards.size}`);
  console.log(`Grup BIN Terdeteksi   : ${binMap.size} BIN unik`);
  console.log(`Duplikat Ditemukan    : ${colors.yellow}${duplicateCount}${colors.reset}`);
  console.log(`Kartu INVALID         : ${colors.red}${invalidCards.length}${colors.reset}`);
  console.log(`Kartu VALID           : ${colors.green}${colors.bright}${validCards.length}${colors.reset}`);
  console.log(`----------------------------------------------------`);

  console.log(`\n💳 Distribusi Brand / Jaringan:`);
  for (const [brand, count] of Object.entries(brandCounts)) {
    console.log(`  - ${colors.cyan}${brand.padEnd(12)}${colors.reset}: ${count} kartu`);
  }

  // Tampilkan Distribusi BIN jika ada metadata
  if (binMetadataMap.size > 0) {
    console.log(`\n🏦 Analisis Issuer / Bank & Tipe Kartu:`);
    for (const [bin, meta] of binMetadataMap.entries()) {
      const cardCount = binMap.get(bin).length;
      console.log(
        `  - BIN ${colors.yellow}${bin}${colors.reset} (${cardCount} kartu): ${meta.issuer} | ${meta.type} (${meta.tier}) - ${meta.country}`
      );
    }
  }

  // Tampilkan sample invalid
  if (invalidCards.length > 0) {
    console.log(`\n${colors.red}${colors.bright}⚠️  Daftar Kartu Invalid / Expired / Duplikat (Sample max 10):${colors.reset}`);
    invalidCards.slice(0, 10).forEach((item) => {
      console.log(`  [Baris ${item.lineNo}] ${item.reason} -> ${colors.dim}${item.raw}${colors.reset}`);
    });
    if (invalidCards.length > 10) {
      console.log(`  ${colors.dim}... dan ${invalidCards.length - 10} kartu invalid lainnya.${colors.reset}`);
    }
  }

  // Simpan output kartu yang valid (.txt)
  if (validCards.length > 0) {
    const outputLines = validCards.map((c) => c.cleanLine).join('\n') + '\n';
    fs.writeFileSync(outputFile, outputLines, 'utf-8');
    console.log(`\n${colors.green}💾 Berhasil menyimpan ${validCards.length} kartu VALID (.txt) ke:${colors.reset}`);
    console.log(`   ${colors.bright}${outputFile}${colors.reset}`);
  }

  // Simpan laporan JSON
  const reportData = {
    generatedAt: new Date().toISOString(),
    inputFile,
    totalLines: lines.length,
    uniqueCards: seenCards.size,
    validCount: validCards.length,
    invalidCount: invalidCards.length,
    duplicateCount,
    brandDistribution: brandCounts,
    binAnalysis: Array.from(binMap.entries()).map(([bin, cards]) => ({
      bin,
      count: cards.length,
      metadata: binMetadataMap.get(bin) || null,
    })),
    validCards: validCards.map((c) => ({
      pan: c.pan,
      expiry: `${c.mm}/${c.yy}`,
      cvv: c.cvv,
      brand: c.brand,
      bin: c.bin,
      binMetadata: binMetadataMap.get(c.bin) || null,
      extra: c.extra,
    })),
    invalidCards: invalidCards.map((ic) => ({
      lineNo: ic.lineNo,
      raw: ic.raw,
      reason: ic.reason,
    })),
  };

  fs.writeFileSync(jsonReportFile, JSON.stringify(reportData, null, 2), 'utf-8');
  console.log(`${colors.green}📄 Berhasil menyimpan laporan analisis (.json) ke:${colors.reset}`);
  console.log(`   ${colors.bright}${jsonReportFile}${colors.reset}\n`);

  return reportData;
}

processValidation().catch((err) => {
  console.error(`${colors.red}Error saat menjalankan validasi:${colors.reset}`, err);
  process.exit(1);
});
