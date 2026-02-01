# Test Framework Fixes - Quick Start Guide
**For /fix-issues workflow**

---

## 🚀 Getting Started

### Step 1: Review the Plan
```bash
# Open the full implementation plan
code .claude/plans/TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md
```

### Step 2: Fix Critical Issues (Week 1)
```bash
# Option A: Fix all P0 issues at once
/fix-issues "Fix all P0 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"

# Option B: Fix issues one by one
/fix-issues "Issue P0-1.1: Remove invalid testTimeout from Jest projects configuration"
/fix-issues "Issue P0-1.2: Create per-project timeout setup files"
/fix-issues "Issue P0-1.3: Document Jest configuration fix"
# ... continue with remaining P0 issues
```

### Step 3: Verify Fixes
```bash
# After each fix
npm test -- --listTests  # Should show no warnings
npm test                 # All tests should pass
```

---

## 📋 Issue Priority Guide

### P0 - Blocking (Fix First!)
**7 issues, ~10 hours**

| Issue ID | Title | Time | Quick Description |
|----------|-------|------|-------------------|
| P0-1.1 | Remove invalid testTimeout | 0.5h | Fix Jest config warnings |
| P0-1.2 | Create timeout setup files | 1h | Per-project timeouts |
| P0-1.3 | Document Jest fix | 0.5h | Update docs |
| P0-2.1 | Fix health check intervals | 1h | P1 partition config |
| P0-2.2 | Create/skip IMPLEMENTATION_PLAN | 0.5h | Missing file fix |
| P0-2.3 | Fix comment pattern tests | 1h | Remove low-value tests |
| P0-3.1 | Remove duplicate tests | 2h | Delete co-located files |

**Fix Command**:
```bash
/fix-issues "Fix all P0 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"
```

**Expected Outcome**: Zero test failures, zero warnings

---

### P1 - High Priority (Week 2)
**8 issues, ~20 hours**

| Issue ID | Title | Time | Dependencies |
|----------|-------|------|--------------|
| P1-1.1 | Audit co-located tests | 2h | P0-3.1 |
| P1-1.2 | Migrate to __tests__ | 3h | P1-1.1 |
| P1-1.3 | Standardize naming | 1h | P1-1.2 |
| P1-2.1 | Create data builders | 4h | None |
| P1-2.2 | Additional builders | 3h | P1-2.1 |
| P1-2.3 | Extract helpers | 2h | P1-2.1 |
| P1-3.1 | Improve test naming | 3h | P1-1.3 |
| P1-3.2 | Consolidate integration | 2h | P1-1.2 |

**Fix Command**:
```bash
/fix-issues "Fix all P1 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"
```

**Expected Outcome**: ADR-009 compliance, 2,000+ lines removed

---

### P2 - Medium Priority (Week 3)
**8 issues, ~24 hours - See full plan for details**

Focus: Performance optimization (50%+ speedup target)

**Fix Command**:
```bash
/fix-issues "Fix all P2 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"
```

---

### P3 - Low Priority (Ongoing)
**5 issues, ~66 hours - See full plan for details**

Focus: Testing excellence, coverage, mutation testing

---

## 🎯 Success Metrics

After each phase, verify:

### Phase 1 Success
- [ ] `npm test -- --listTests` shows **zero warnings**
- [ ] `npm test` shows **zero failures**
- [ ] **3 duplicate test files** deleted
- [ ] Baseline metrics captured

### Phase 2 Success
- [ ] **Zero co-located tests** (all in `__tests__/`)
- [ ] **2,000+ lines** of test code removed
- [ ] Test helper library with **10+ utilities**
- [ ] Updated TEST_ARCHITECTURE.md

### Phase 3 Success
- [ ] Unit tests complete in **<10 seconds**
- [ ] Integration tests complete in **<2 minutes**
- [ ] Full suite completes in **<3 minutes**
- [ ] Performance monitoring in place

---

## 🔍 Common Commands

### Fix Individual Issues
```bash
# By issue ID
/fix-issues "Issue P0-1.1: Remove invalid testTimeout from Jest projects configuration"

# By description
/fix-issues "Fix Jest timeout configuration warnings"
```

### Fix by Category
```bash
# All Jest config issues
/fix-issues "Fix all P0-1.x issues (Jest configuration)"

# All duplicate test issues
/fix-issues "Fix Issue P0-3.1 (Remove duplicate co-located tests)"
```

### Fix by Phase
```bash
# Entire phase
/fix-issues "Fix all Phase 1 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"

# Just critical blockers
/fix-issues "Fix all P0 blocking issues"
```

### Verify After Fixes
```bash
# Check for warnings
npm test -- --listTests 2>&1 | grep -i "warning"
# Should output nothing

# Run specific test category
npm test -- --selectProjects unit
npm test -- --selectProjects integration

# Check no co-located tests remain
find . -path "*/src/*.test.ts" -not -path "*/node_modules/*"
# Should output nothing after P0-3.1 and P1-1.2
```

---

## 📦 What Each Phase Delivers

### Phase 1: Critical Fixes ✅
**Delivers**: Stable test suite
- No Jest warnings
- No failing tests
- No duplicate tests
- Clean baseline for improvements

### Phase 2: Structure & Organization ✅
**Delivers**: Maintainable test suite
- ADR-009 compliant structure
- Test builder library
- Consolidated tests
- Better test names

### Phase 3: Performance Optimization ✅
**Delivers**: Fast test suite
- 50%+ speedup (10-15min → <3min)
- Optimized initialization
- Better parallelization
- Performance monitoring

### Phase 4: Testing Excellence ✅
**Delivers**: World-class test suite
- 80%+ coverage
- Contract testing
- Mutation testing
- Zero flakiness

---

## 🐛 Troubleshooting

### Issue: /fix-issues doesn't understand the issue ID
**Solution**: Use the full issue title or description
```bash
# Instead of
/fix-issues "P0-1.1"

# Use
/fix-issues "Issue P0-1.1: Remove invalid testTimeout from Jest projects configuration"
```

### Issue: Tests fail after applying a fix
**Solution**: Check the Acceptance Criteria section of that issue
```bash
# Each issue has testing commands, run them
npm test -- [specific-test-path]

# Check for import errors
npm run typecheck
```

### Issue: Want to see what's in an issue before fixing
**Solution**: Read the issue in the plan file
```bash
# Open plan and search for issue ID
code .claude/plans/TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md
# Then Ctrl+F "P0-1.1"
```

---

## 📚 Related Documentation

- **Full Implementation Plan**: `.claude/plans/TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md`
- **Research Report**: `docs/reports/TEST_FRAMEWORK_ENHANCEMENT_RESEARCH.md`
- **Quick Reference**: `TEST_FRAMEWORK_IMPROVEMENTS_SUMMARY.md`
- **Critical Fixes**: `CRITICAL_FIXES_CHECKLIST.md`

---

## 💡 Pro Tips

1. **Fix P0 issues first** - They're blocking everything else
2. **Run tests after each fix** - Catch regressions immediately
3. **Read acceptance criteria** - Know what success looks like
4. **Use git commits per issue** - Easy to revert if needed
5. **Track your progress** - Check off items in the plan

---

## 🎬 Example Session

```bash
# 1. Start with Phase 1
/fix-issues "Fix all P0 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"

# 2. Verify success
npm test -- --listTests 2>&1 | grep -i "warning"  # Should be empty
npm test  # Should pass

# 3. Move to Phase 2
/fix-issues "Fix all P1 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"

# 4. Verify structure
find . -path "*/src/*.test.ts" -not -path "*/node_modules/*"  # Should be empty

# 5. Continue to Phase 3...
```

---

**Last Updated**: February 1, 2026
**Quick Start Version**: 1.0

---

**Ready to start?** Run:
```bash
/fix-issues "Fix all P0 issues from TEST_FRAMEWORK_FIXES_IMPLEMENTATION_PLAN.md"
```
