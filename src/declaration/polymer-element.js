/*
 * Copyright 2013 The Polymer Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style
 * license that can be found in the LICENSE file.
 */
(function(scope) {

  // imports
  
  var extend = Polymer.extend;
  var apis = scope.api.declaration;

  // imperative implementation: Polymer()
  
  // maps tag names to prototypes
  var registry = {};

  function getRegisteredPrototype(name) {
    return registry[name];
  }

  // elements waiting for prototype, by name
  var waitPrototype = {};

  // specify an 'own' prototype for tag `name`
  function element(name, prototype) {
    //console.log('registering [' + name + ']');
    // cache the prototype
    registry[name] = prototype || {};
    // notify the registrar waiting for 'name', if any
    notifyPrototype(name);
  }

  function notifyPrototype(name) {
    if (waitPrototype[name]) {
      waitPrototype[name].registerWhenReady();
      delete waitPrototype[name];
    }
  }

  // elements waiting for super, by name
  var waitSuper = {};

  function notifySuper(name) {
    var waiting = waitSuper[name];
    if (waiting) {
      waiting.forEach(function(w) {
        w.registerWhenReady();
      });
      delete waitSuper[name];
    }
  }

  // returns a prototype that chains to <tag> or HTMLElement
  function generatePrototype(tag) {
    return Object.create(HTMLElement.getPrototypeForTag(tag));
  }
  
  // On platforms that do not support __proto__ (IE10), the prototype chain
  // of a custom element is simulated via installation of __proto__.
  // Although custom elements manages this, we install it here so it's 
  // available during desugaring.
  function ensurePrototypeTraversal(prototype) {
    if (!Object.__proto__) {
      var ancestor = Object.getPrototypeOf(prototype);
      prototype.__proto__ = ancestor;
      if (scope.isBase(ancestor)) {
        ancestor.__proto__ = Object.getPrototypeOf(ancestor);
      }
    }
  }

  // declarative implementation: <polymer-element>

  var prototype = generatePrototype();

  extend(prototype, {
    // TODO(sjmiles): temporary BC
    readyCallback: function() {
      this.createdCallback();
    },
    createdCallback: function() {
      // fetch the element name
      this.name = this.getAttribute('name');
      // install element definition, if ready
      this.registerWhenReady();
    },
    registerWhenReady: function() {
      var name = this.name;
      // if we have no prototype
      if (!getRegisteredPrototype(name)) {
        // then wait for a prototype
        waitPrototype[name] = this;
        // TODO(sjmiles): there is a massive asynchrony between parsing
        // HTML in imports and executing script that foils this `async` gambit
        // Ideally the import polyfill has timing closer to the real deal; in
        // the meantime, invert the strategy and require `noscript` marking
        // instead.
        /*
        // if we are not explicitly async,
        // then wait for end of microtask(-ish)
        // and use whatever prototype is available
        if (!this.hasAttribute('async')) {
          setTimeout(function() {
            if (!getRegisteredPrototype(name)) {
              console.warn('giving up waiting for script for [' + name + ']');
              element(name, null);
            }
          }, 3000);
        }
        */
        if (this.hasAttribute('noscript')) {
          // go async so the parser can process the element's children before
          // registration
          setTimeout(function() {
            element(name, null);
          }, 0);
        }
        return;
      }
      // fetch our extendee name
      var extendee = this.getAttribute('extends');
      // if extending a custom element...
      if (extendee && extendee.indexOf('-') >= 0) {
        // wait for the extendee to be registered first
        if (!getRegisteredPrototype(extendee)) {
          (waitSuper[extendee] = (waitSuper[extendee] || [])).push(this);
          return;
        }
      }
      // TODO(sjmiles): HTMLImports polyfill awareness
      if (document.contains(this) && window.HTMLImports && !HTMLImports.readyTime) {
        addEventListener('HTMLImportsLoaded', function() {
          this.register(name, extendee);
        }.bind(this));
      } else {
        this.register(name, extendee);
      }
    },
    register: function(name, extendee) {
      //console.log(name, extendee);
      // build prototype combining extendee, Polymer base, and named api
      this.prototype = this.generateCustomPrototype(name, extendee);
      // backref
      this.prototype.element = this;
      // TODO(sorvell): install a helper method this.resolvePath to aid in 
      // setting resource paths. e.g. 
      // this.$.image.src = this.resolvePath('images/foo.png')
      // Potentially remove when spec bug is addressed.
      // https://www.w3.org/Bugs/Public/show_bug.cgi?id=21407
      this.addResolvePathApi();
      ensurePrototypeTraversal(this.prototype);
      // declarative features
      this.desugar();
      // under ShadowDOMPolyfill, transforms to approximate missing CSS features
      if (window.ShadowDOMPolyfill) {
        Platform.ShadowCSS.shimStyling(this.templateContent(), name, extendee);
      }
      // register our custom element
      this.registerPrototype(name);
      // reference constructor in a global named by 'constructor' attribute
      this.publishConstructor();
      // subclasses may now register themselves
      notifySuper(name);
    },
    // implement various declarative features
    desugar: function(prototype) {
      // parse `attribute` attribute and `publish` object
      this.parseAttributes();
      // parse on-* delegates declared on `this` element
      this.parseHostEvents();
      // parse on-* delegates declared in templates
      this.parseLocalEvents();
      // install external stylesheets as if they are inline
      this.installSheets();
      // allow custom element access to the declarative context
      if (this.prototype.registerCallback) {
        this.prototype.registerCallback(this);
      }
      // cache the list of custom prototype names for faster reflection
      this.cacheProperties();
    },
    // prototype marshaling
    // build prototype combining extendee, Polymer base, and named api
    generateCustomPrototype: function (name, extnds) {
      // basal prototype
      var prototype = this.generateBasePrototype(extnds);
      // mixin registered custom api
      return this.addNamedApi(prototype, name);
    },
    // build prototype combining extendee, Polymer base, and named api
    generateBasePrototype: function(extnds) {
      // create a prototype based on tag-name extension
      var prototype = generatePrototype(extnds);
      // insert base api in inheritance chain (if needed)
      return this.ensureBaseApi(prototype);
    },
    // install Polymer instance api into prototype chain, as needed 
    ensureBaseApi: function(prototype) { 
      if (!prototype.PolymerBase) {
        Object.keys(scope.api.instance).forEach(function(n) {
          extend(prototype, scope.api.instance[n]);
        });
        prototype = Object.create(prototype);
      }
      // inherit publishing meta-data
      this.inheritAttributesObjects(prototype);
      // inherit event delegates
      this.inheritDelegates(prototype);
      // return buffed-up prototype
      return prototype;
    },
    // mix api registered to 'name' into 'prototype' 
    addNamedApi: function(prototype, name) { 
      // combine custom api into prototype
      return extend(prototype, getRegisteredPrototype(name));
    },
    // make a fresh object that inherits from a prototype object
    inheritObject: function(prototype, name) {
      // copy inherited properties onto a new object
      prototype[name] = extend({}, Object.getPrototypeOf(prototype)[name]);
    },
    // register 'prototype' to custom element 'name', store constructor 
    registerPrototype: function(name) { 
      // register the custom type
      this.ctor = document.register(name, {
        prototype: this.prototype
      });
      // constructor shenanigans
      this.prototype.constructor = this.ctor;
      // register the prototype with HTMLElement for name lookup
      HTMLElement.register(name, this.prototype);
    },
    // if a named constructor is requested in element, map a reference
    // to the constructor to the given symbol
    publishConstructor: function() {
      var symbol = this.getAttribute('constructor');
      if (symbol) {
        window[symbol] = this.ctor;
      }
    }
  });

  Object.keys(apis).forEach(function(n) {
    extend(prototype, apis[n]);
  });

  // register polymer-element with document

  document.register('polymer-element', {prototype: prototype});

  // namespace shenanigans so we can expose our scope on the registration function

  // TODO(sjmiles): find a way to do this that is less terrible
  // copy window.Polymer properties onto `element()`
  extend(element, scope);
  // make window.Polymer reference `element()`
  window.Polymer = element;

})(Polymer);
