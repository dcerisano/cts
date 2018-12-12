import {
  TestCollection,
} from '.';
import {
  ParamIterable,
  punit,
  poptions,
  pcombine,
} from './params';

// "unit tests" for the testing framework
(async function unittests() {
  const tests = new TestCollection();

  tests.add("async_callback",
      punit(),
      async (p: any) => console.log(p));
  
  function add(name: string, params: ParamIterable) {
    tests.add(name, params, console.log);
  }

  add("list", poptions('hello', [1, 2, 3]));
  add("unit", punit());
  add("combine_none", pcombine([]));
  add("combine_unit_unit", pcombine([punit(), punit()]));
  add("combiner_lists", pcombine([
    poptions('x', [1, 2]),
    poptions('y', ['a', 'b']),
    punit(),
  ]));
  add("combiner_arrays", pcombine([
    [{x: 1, y: 2}, {x: 10, y: 20}],
    [{z: 'z'}, {w: 'w'}],
  ]));
  add("combiner_mixed", pcombine([
    poptions('x', [1, 2]),
    [{z: 'z'}, {w: 'w'}],
  ]));

  await tests.run();
})();