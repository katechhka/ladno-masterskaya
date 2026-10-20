// One implementation of business rules for local SQLite and asynchronous Turso.
// A yielded ordinary value is consumed synchronously; promises resume the same
// generator after completion, preserving the transaction callback and its state.
export function flow(operation) {
  return function (...args) {
    const iterator = operation.apply(this, args);
    function step(method, value) {
      while(true){
        const result = iterator[method](value);
        if (result.done) return result.value;
        if (result.value && typeof result.value.then === 'function') {
          return result.value.then(value => step('next', value), error => step('throw', error));
        }
        method='next';value=result.value;
      }
    }
    return step('next');
  };
}
