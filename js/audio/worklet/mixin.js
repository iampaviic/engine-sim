// Lets one class be written across several files: copies the methods (and
// accessors) of each part onto the target's prototype, with the same
// descriptors a class body would have given them.
export function mixin(target, ...parts) {
  for (const part of parts) {
    for (const name of Object.getOwnPropertyNames(part.prototype)) {
      if (name === 'constructor') continue;
      if (Object.prototype.hasOwnProperty.call(target.prototype, name)) throw new Error('mixin: ' + target.name + '.' + name + ' is defined twice');
      Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
    }
  }
}
