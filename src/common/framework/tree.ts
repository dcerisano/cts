import { TestFileLoader } from './file_loader.js';
import { TestCaseRecorder } from './logging/test_case_recorder.js';
import { CaseParamsRW } from './params_utils.js';
import { compareQueries, Ordering } from './query/compare.js';
import {
  TestQuery,
  TestQueryMultiCase,
  TestQuerySingleCase,
  TestQueryMultiFile,
  TestQueryMultiTest,
} from './query/query.js';
import { kBigSeparator, kWildcard, kPathSeparator, kParamSeparator } from './query/separators.js';
import { stringifySingleParam } from './query/stringify_params.js';
import { RunCase, RunFn } from './test_group.js';
import { assert } from './util/util.js';

// `loadTreeForQuery()` loads a TestTree for a given queryToLoad.
// The resulting tree is a linked-list all the way from `suite:*` to queryToLoad,
// and under queryToLoad is a tree containing every case matched by queryToLoad.
//
// `subqueriesToExpand` influences the `collapsible` flag on nodes in the resulting tree.
// A node is considered "collapsible" if none of the subqueriesToExpand is a StrictSubset
// of that node.
//
// In WebKit/Blink-style web_tests, an expectation file marks individual cts.html "variants" as
// "Failure", "Crash", etc.
// By passing in the list of expectations as the subqueriesToExpand, we can programmatically
// subdivide the cts.html "variants" list to be able to implement arbitrarily-fine suppressions
// (instead of having to suppress entire test files, which would lose a lot of coverage).
//
// `iterateCollapsedQueries()` produces the list of queries for the variants list.
//
// Though somewhat complicated, this system has important benefits:
//   - Avoids having to suppress entire test files, which would cause large test coverage loss.
//   - Minimizes the number of page loads needed for fine-grained suppressions.
//     (In the naive case, we could do one page load per test case - but the test suite would
//     take impossibly long to run.)
//   - Enables developers to put any number of tests in one file as appropriate, without worrying
//     about expectation granularity.

export interface TestSubtree<T extends TestQuery = TestQuery> {
  /**
   * Readable "relative" name for display in standalone runner.
   * Not always the exact relative name, because sometimes there isn't
   * one (e.g. s:f:* relative to s:f,*), but something that is readable.
   */
  readonly readableRelativeName: string;
  readonly query: T;
  readonly children: Map<string, TestTreeNode>;
  readonly collapsible: boolean;
  description?: string;
}

export interface TestTreeLeaf {
  /**
   * Readable "relative" name for display in standalone runner.
   */
  readonly readableRelativeName: string;
  readonly query: TestQuerySingleCase;
  readonly run: RunFn;
}

export type TestTreeNode = TestSubtree | TestTreeLeaf;

export class TestTree {
  readonly root: TestSubtree;

  constructor(root: TestSubtree) {
    this.root = root;
  }

  iterateCollapsedQueries(): IterableIterator<TestQuery> {
    return TestTree.iterateSubtreeCollapsedQueries(this.root);
  }

  iterateLeaves(): IterableIterator<TestTreeLeaf> {
    return TestTree.iterateSubtreeLeaves(this.root);
  }

  /**
   * If a parent and its child are at different levels, then
   * generally the parent has only one child, i.e.:
   *   a,* { a,b,* { a,b:* { ... } } }
   * Collapse that down into:
   *   a,* { a,b:* { ... } }
   * which is less needlessly verbose when displaying the tree in the standalone runner.
   */
  dissolveLevelBoundaries(): void {
    const newRoot = dissolveLevelBoundaries(this.root);
    assert(newRoot === this.root);
  }

  toString(): string {
    return TestTree.subtreeToString('(root)', this.root, '');
  }

  static *iterateSubtreeCollapsedQueries(subtree: TestSubtree): IterableIterator<TestQuery> {
    for (const [, child] of subtree.children) {
      if ('children' in child && !child.collapsible) {
        yield* TestTree.iterateSubtreeCollapsedQueries(child);
      } else {
        yield child.query;
      }
    }
  }

  static *iterateSubtreeLeaves(subtree: TestSubtree): IterableIterator<TestTreeLeaf> {
    for (const [, child] of subtree.children) {
      if ('children' in child) {
        yield* TestTree.iterateSubtreeLeaves(child);
      } else {
        yield child;
      }
    }
  }

  static subtreeToString(name: string, tree: TestTreeNode, indent: string): string {
    const collapsible = 'run' in tree ? '>' : tree.collapsible ? '+' : '-';
    let s = indent + `${collapsible} ${JSON.stringify(name)} => ${tree.query}`;
    if ('children' in tree) {
      if (tree.description !== undefined) {
        s += `\n${indent}  | ${JSON.stringify(tree.description)}`;
      }

      for (const [name, child] of tree.children) {
        s += '\n' + TestTree.subtreeToString(name, child, indent + '  ');
      }
    }
    return s;
  }
}

// TODO: Consider having subqueriesToExpand actually impact the depth-order of params in the tree.
export async function loadTreeForQuery(
  loader: TestFileLoader,
  queryToLoad: TestQuery,
  subqueriesToExpand: TestQuery[]
): Promise<TestTree> {
  const suite = queryToLoad.suite;
  const specs = await loader.listing(suite);

  const subqueriesToExpandEntries = Array.from(subqueriesToExpand.entries());
  const seenSubqueriesToExpand: boolean[] = new Array(subqueriesToExpand.length);
  seenSubqueriesToExpand.fill(false);

  const isCollapsible = (subquery: TestQuery) =>
    subqueriesToExpandEntries.every(([i, toExpand]) => {
      const ordering = compareQueries(toExpand, subquery);

      // If toExpand == subquery, no expansion is needed (but it's still "seen").
      if (ordering === Ordering.Equal) seenSubqueriesToExpand[i] = true;
      return ordering !== Ordering.StrictSubset;
    });

  // L0 = suite-level, e.g. suite:*
  // L1 =  file-level, e.g. suite:a,b:*
  // L2 =  test-level, e.g. suite:a,b:c,d:*
  // L3 =  case-level, e.g. suite:a,b:c,d:
  let foundCase = false;
  // L0 is suite:*
  const subtreeL0 = makeTreeForSuite(suite);
  isCollapsible(subtreeL0.query); // mark seenSubqueriesToExpand
  for (const entry of specs) {
    if (entry.file.length === 0 && 'readme' in entry) {
      // Suite-level readme.
      assert(subtreeL0.description === undefined);
      subtreeL0.description = entry.readme.trim();
      continue;
    }

    {
      const queryL1 = new TestQueryMultiFile(suite, entry.file);
      const orderingL1 = compareQueries(queryL1, queryToLoad);
      if (orderingL1 === Ordering.Unordered) {
        // File path is not matched by this query.
        continue;
      }
    }

    if ('readme' in entry) {
      // Entry is a README that is an ancestor or descendant of the query.
      // (It's included for display in the standalone runner.)

      // readmeSubtree is suite:a,b,*
      // (This is always going to dedup with a file path, if there are any test spec files under
      // the directory that has the README).
      const readmeSubtree: TestSubtree<TestQueryMultiFile> = addSubtreeForDirPath(
        subtreeL0,
        entry.file
      );
      assert(readmeSubtree.description === undefined);
      readmeSubtree.description = entry.readme.trim();
      continue;
    }
    // Entry is a spec file.

    const spec = await loader.importSpecFile(queryToLoad.suite, entry.file);
    const description = spec.description.trim();
    // subtreeL1 is suite:a,b:*
    const subtreeL1: TestSubtree<TestQueryMultiTest> = addSubtreeForFilePath(
      subtreeL0,
      entry.file,
      description,
      isCollapsible
    );

    // TODO: If tree generation gets too slow, avoid actually iterating the cases in a file
    // if there's no need to (based on the subqueriesToExpand).
    for (const t of spec.g.iterate()) {
      {
        const queryL3 = new TestQuerySingleCase(suite, entry.file, t.id.test, t.id.params);
        const orderingL3 = compareQueries(queryL3, queryToLoad);
        if (orderingL3 === Ordering.Unordered || orderingL3 === Ordering.StrictSuperset) {
          // Case is not matched by this query.
          continue;
        }
      }

      // subtreeL2 is suite:a,b:c,d:*
      const subtreeL2: TestSubtree<TestQueryMultiCase> = addSubtreeForTestPath(
        subtreeL1,
        t.id.test,
        isCollapsible
      );

      // Leaf for case is suite:a,b:c,d:x=1;y=2
      addLeafForCase(subtreeL2, t, isCollapsible);

      foundCase = true;
    }
  }

  for (const [i, sq] of subqueriesToExpandEntries) {
    const seen = seenSubqueriesToExpand[i];
    assert(
      seen,
      `subqueriesToExpand entry did not match anything \
(can happen due to overlap with another subquery): ${sq.toString()}`
    );
  }
  assert(foundCase, 'Query does not match any cases');

  return new TestTree(subtreeL0);
}

function makeTreeForSuite(suite: string): TestSubtree<TestQueryMultiFile> {
  return {
    readableRelativeName: suite + kBigSeparator,
    query: new TestQueryMultiFile(suite, []),
    children: new Map(),
    collapsible: false,
  };
}

function addSubtreeForDirPath(
  tree: TestSubtree<TestQueryMultiFile>,
  file: string[]
): TestSubtree<TestQueryMultiFile> {
  const subqueryFile: string[] = [];
  // To start, tree is suite:*
  // This loop goes from that -> suite:a,* -> suite:a,b,*
  for (const part of file) {
    subqueryFile.push(part);
    tree = getOrInsertSubtree(part, tree, () => {
      const query = new TestQueryMultiFile(tree.query.suite, subqueryFile);
      return { readableRelativeName: part + kPathSeparator + kWildcard, query, collapsible: false };
    });
  }
  return tree;
}

function addSubtreeForFilePath(
  tree: TestSubtree<TestQueryMultiFile>,
  file: string[],
  description: string,
  checkCollapsible: (sq: TestQuery) => boolean
): TestSubtree<TestQueryMultiTest> {
  // To start, tree is suite:*
  // This goes from that -> suite:a,* -> suite:a,b,*
  tree = addSubtreeForDirPath(tree, file);
  // This goes from that -> suite:a,b:*
  const subtree = getOrInsertSubtree('', tree, () => {
    const query = new TestQueryMultiTest(tree.query.suite, tree.query.filePathParts, []);
    assert(file.length > 0, 'file path is empty');
    return {
      readableRelativeName: file[file.length - 1] + kBigSeparator + kWildcard,
      query,
      description,
      collapsible: checkCollapsible(query),
    };
  });
  return subtree;
}

function addSubtreeForTestPath(
  tree: TestSubtree<TestQueryMultiTest>,
  test: readonly string[],
  isCollapsible: (sq: TestQuery) => boolean
): TestSubtree<TestQueryMultiCase> {
  const subqueryTest: string[] = [];
  // To start, tree is suite:a,b:*
  // This loop goes from that -> suite:a,b:c,* -> suite:a,b:c,d,*
  for (const part of test) {
    subqueryTest.push(part);
    tree = getOrInsertSubtree(part, tree, () => {
      const query = new TestQueryMultiTest(
        tree.query.suite,
        tree.query.filePathParts,
        subqueryTest
      );
      return {
        readableRelativeName: part + kPathSeparator + kWildcard,
        query,
        collapsible: isCollapsible(query),
      };
    });
  }
  // This goes from that -> suite:a,b:c,d:*
  return getOrInsertSubtree('', tree, () => {
    const query = new TestQueryMultiCase(
      tree.query.suite,
      tree.query.filePathParts,
      subqueryTest,
      {}
    );
    assert(subqueryTest.length > 0, 'subqueryTest is empty');
    return {
      readableRelativeName: subqueryTest[subqueryTest.length - 1] + kBigSeparator + kWildcard,
      kWildcard,
      query,
      collapsible: isCollapsible(query),
    };
  });
}

function addLeafForCase(
  tree: TestSubtree<TestQueryMultiTest>,
  t: RunCase,
  checkCollapsible: (sq: TestQuery) => boolean
): void {
  const query = tree.query;
  let name: string = '';
  const subqueryParams: CaseParamsRW = {};

  // To start, tree is suite:a,b:c,d:*
  // This loop goes from that -> suite:a,b:c,d:x=1;* -> suite:a,b:c,d:x=1;y=2;*
  for (const [k, v] of Object.entries(t.id.params)) {
    name = stringifySingleParam(k, v);
    subqueryParams[k] = v;

    tree = getOrInsertSubtree(name, tree, () => {
      const subquery = new TestQueryMultiCase(
        query.suite,
        query.filePathParts,
        query.testPathParts,
        subqueryParams
      );
      return {
        readableRelativeName: name + kParamSeparator + kWildcard,
        query: subquery,
        collapsible: checkCollapsible(subquery),
      };
    });
  }

  // This goes from that -> suite:a,b:c,d:x=1;y=2
  const subquery = new TestQuerySingleCase(
    query.suite,
    query.filePathParts,
    query.testPathParts,
    subqueryParams
  );
  checkCollapsible(subquery); // mark seenSubqueriesToExpand
  insertLeaf(tree, subquery, t);
}

function getOrInsertSubtree<T extends TestQuery>(
  key: string,
  parent: TestSubtree,
  createSubtree: () => Omit<TestSubtree<T>, 'children'>
): TestSubtree<T> {
  let v: TestSubtree<T>;
  const child = parent.children.get(key);
  if (child !== undefined) {
    assert('children' in child); // Make sure cached subtree is not actually a leaf
    v = child as TestSubtree<T>;
  } else {
    v = { ...createSubtree(), children: new Map() };
    parent.children.set(key, v);
  }
  return v;
}

function insertLeaf(parent: TestSubtree, query: TestQuerySingleCase, t: RunCase) {
  const key = '';
  const leaf: TestTreeLeaf = {
    readableRelativeName: readableNameForCase(query),
    query,
    run: (rec: TestCaseRecorder) => t.run(rec),
  };
  assert(!parent.children.has(key));
  parent.children.set(key, leaf);
}

function dissolveLevelBoundaries(tree: TestTreeNode): TestTreeNode {
  if ('children' in tree) {
    if (tree.children.size === 1 && tree.description === undefined) {
      // Loops exactly once
      for (const [, child] of tree.children) {
        if (child.query.level > tree.query.level) {
          const newtree = dissolveLevelBoundaries(child);

          return newtree;
        }
      }
    }

    for (const [k, child] of tree.children) {
      const newChild = dissolveLevelBoundaries(child);
      if (newChild !== child) {
        tree.children.set(k, newChild);
      }
    }
  }
  return tree;
}

/** Generate a readable relative name for a case (used in standalone). */
function readableNameForCase(query: TestQuerySingleCase): string {
  const paramsKeys = Object.keys(query.params);
  if (paramsKeys.length === 0) {
    return query.testPathParts[query.testPathParts.length - 1] + kBigSeparator;
  } else {
    const lastKey = paramsKeys[paramsKeys.length - 1];
    return stringifySingleParam(lastKey, query.params[lastKey]);
  }
}
