import { PrimitiveSphereFeaturePlugin } from './exampleFeature.js';


export default (app) => {
    console.log("This is the context passed in to the plugin.", app)
    app.addToolbarButton('🧩', 'Hello', () => {
        console.log('Hello from plugin')
        console.log("This is the context passed in to the plugin.", app)
        alert("Yay");
    });
    app.addSidePanel('Plugin Panel', () => {
        const div = document.createElement('div');
        div.textContent = 'This was added by a plugin.';
        return div;
    });
    

    PrimitiveSphereFeaturePlugin.setup(app)
    app.registerFeature(PrimitiveSphereFeaturePlugin); // optional
};

