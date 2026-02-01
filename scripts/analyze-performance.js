#!/usr/bin/env node
/**
 * Performance Analysis Script
 *
 * Analyzes slow-tests.json and compares with previous run to track performance changes.
 *
 * Usage:
 *   npm run test:perf
 *   node scripts/analyze-performance.js
 */

const fs = require('fs');
const path = require('path');

const reportPath = path.join(__dirname, '../slow-tests.json');
const previousReportPath = path.join(__dirname, '../slow-tests.previous.json');

if (!fs.existsSync(reportPath)) {
  console.log('✅ No slow tests detected!');
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

console.log('\n📊 Performance Analysis\n');
console.log('━'.repeat(80));
console.log(`Report generated: ${report.timestamp}`);
console.log(`Total slow tests: ${report.summary.total}`);
console.log('\nBy project:');
Object.entries(report.summary.byProject).forEach(([project, count]) => {
  console.log(`  ${project}: ${count} slow test(s)`);
});
console.log('━'.repeat(80));

// Compare with previous run (if available)
if (fs.existsSync(previousReportPath)) {
  const previousReport = JSON.parse(fs.readFileSync(previousReportPath, 'utf8'));
  const delta = report.summary.total - previousReport.summary.total;

  console.log('\n📈 Comparison with Previous Run\n');
  console.log('━'.repeat(80));

  if (delta > 0) {
    console.log(`⚠️  Performance regression: +${delta} slow test(s) since last run`);
    console.log(`   Previous: ${previousReport.summary.total} slow tests`);
    console.log(`   Current:  ${report.summary.total} slow tests`);

    // Show which tests became slow
    const previousSlowTestNames = new Set(
      previousReport.slowTests.map(t => `${t.testPath}::${t.testName}`)
    );
    const newSlowTests = report.slowTests.filter(
      t => !previousSlowTestNames.has(`${t.testPath}::${t.testName}`)
    );

    if (newSlowTests.length > 0) {
      console.log('\n   New slow tests:');
      newSlowTests.slice(0, 5).forEach(test => {
        console.log(`   - [${test.project}] ${test.duration}ms - ${test.testName}`);
      });
      if (newSlowTests.length > 5) {
        console.log(`   ... and ${newSlowTests.length - 5} more`);
      }
    }
  } else if (delta < 0) {
    console.log(`✅ Performance improvement: ${-delta} fewer slow test(s) since last run`);
    console.log(`   Previous: ${previousReport.summary.total} slow tests`);
    console.log(`   Current:  ${report.summary.total} slow tests`);
  } else {
    console.log(`➡️  No change in slow test count since last run`);
    console.log(`   Both runs: ${report.summary.total} slow tests`);
  }

  console.log('━'.repeat(80));
} else {
  console.log('\n💡 Tip: Run tests again to track performance changes over time\n');
}

// Show slowest tests
if (report.slowTests.length > 0) {
  console.log('\n🐌 Slowest Tests (Top 10)\n');
  console.log('━'.repeat(80));

  report.slowTests.slice(0, 10).forEach((test, index) => {
    const overagePercent = ((test.duration / test.threshold - 1) * 100).toFixed(0);
    console.log(
      `${index + 1}. [${test.project}] ${test.duration}ms ` +
      `(${overagePercent}% over ${test.threshold}ms threshold)`
    );
    console.log(`   ${test.testName}`);
    console.log(`   ${path.relative(process.cwd(), test.testPath)}`);
    console.log('');
  });

  if (report.slowTests.length > 10) {
    console.log(`... and ${report.slowTests.length - 10} more slow tests`);
  }

  console.log('━'.repeat(80));
}

// Save current report for next comparison
try {
  fs.copyFileSync(reportPath, previousReportPath);
  console.log('\n✅ Report saved for comparison with next run\n');
} catch (error) {
  console.error(`\n⚠️  Could not save report for comparison: ${error.message}\n`);
}

// Exit with appropriate code
if (report.summary.total > 0) {
  console.log('💡 Consider optimizing slow tests or adjusting thresholds if acceptable\n');
  process.exit(0); // Don't fail - just inform
} else {
  console.log('🎉 All tests within performance budgets!\n');
  process.exit(0);
}
