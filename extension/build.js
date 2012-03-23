
var path = require("path");
var fs = require("fs");
var shell = require("shelljs");
var copy = require("dryice").copy;

function help()
{
    console.log('Usage:');
    console.log('');
    console.log('1. In order to build Firebug (including tracing) xpi run:');
    console.log('       $ node build.js');
    console.log('   The final xpi + update.rdf file will be located in the \'release\' sub directory.');
    console.log('');
    console.log('   If GETFIREBUG is properly specified in content/firebug/branch.properties');
    console.log('   (it assumes you have fbug and getfirebug.com directories at the same level)');
    console.log('   The xpi + update.rdf will be also deployed for you there and so you can');
    console.log('   just commit.');
    console.log('');
    console.log('   The release directory should contain two files:');
    console.log('   - firebug<version>.xpi (including updateURL) for getfirebug.com');
    console.log('   - firebug<version>-amo.xpi (disabled update) for AMO');
    console.log('');
    /*
    TODO: There were no targets for release ...
    console.log('2. In order to build Firebug final release (no tracing) run:');
    console.log('       $ node build.js release');
    console.log('   Again xpi files will be located in the \'release\' directory.');
    console.log('');
    */
    console.log('2. To check GETFIREBUG value run:');
    console.log('       $ node build.js echo');
    console.log('');
    console.log('3. To build xpi and generate JS doc (from source comments) run:');
    console.log('       $ node build.js jsdoc');
    console.log('');
    console.log('4. To build xpi for Babelzilla run:');
    console.log('       $ node build.js bz');
    console.log('   - All BZ locales should be stored in "bz-locale" directory.');
}

function main()
{
  var args = process.argv;
    if (args.length < 3)
    {
        build();
    }
    else if (args.length >= 4 || args[2] === "help")
    {
        help();
    }
    else if (args[2] === "echo")
    {
        echo();
    }
    else if (args[2] === "jsdoc")
    {
        jsdoc();
    }
    else if (args[2] === "bz")
    {
        bz();
    }
    else
    {
        help();
    }
}

// <property file="content/firebug/branch.properties"/>
var getfirebugDir = 'none';
var packageFile = fs.readFileSync(__dirname + '/package.json', 'utf8');
var version = JSON.parse(packageFile).version;
var release = '';

var buildDir = "./build";
var releaseDir = "./release";
var deployXpiDir = getfirebugDir + "/releases/firebug/" + version + "";
var deployJsdocDir = getfirebugDir + "/developer/api/firebug" + version + "";
var bzLocaleDir = "./bz-locale";

var deployDirAvailable = path.existsSync(getfirebugDir) &&
        fs.statSync(getfirebugDir).isDirectory;

function prepareBuild() {
    shell.mkdir(buildDir);
    shell.mkdir(releaseDir);

    // Copy non JS resources
    copy({
        source: {
            root: '.',
            // TODO: Previously we copied everything that matched this set of
            // extensions: js, xul, properties, css, html, xml, dtd, ong, gif, ico, manifest, txt, html
            // and then deleted. Now we copy everything with exclusions, but
            // we don't know what extra exclusions were missing
            exclude: [
                /.*\.js/, /.*\.graphml/, /build\.xml/, /node_modules/,
                /install\.rdf\.tpl\.xml/, /update\.rdf\.tpl\.xml/
            ]
        },
        dest: buildDir
    });

    var project = copy.createCommonJsProject({
      roots: [ __dirname + '/content' ]
    });
    copy({
        source: [
            copy.getMiniRequire(),
            {
                project: project,
                require: [
                    /*
                    "firebug/chrome/chrome",
                    "firebug/lib/lib",
                    "firebug/firebug",
                    "firebug/bti/inProcess/browser"
                    */
                    "firebug/net/netPanel"
                ]
            }
        ],
        dest: buildDir + '/main.js'
    });

    copy({
      source: { value:project.getDependencyGraphML() },
      dest: 'netpanel.graphml'
    });

    // Copy install.rdf template into the build dir
    copy({
        source: 'install.rdf.tpl.xml',
        dest: buildDir + '/install.rdf'
    })
}

/**
 * Munge define lines to add module names
 */
function moduleDefines(input, source) {
    if (!source) {
        console.log('- Source without filename passed to moduleDefines().' +
            ' Skipping addition of define(...) wrapper.');
        return input;
    }
    input = (typeof input !== 'string') ? input.toString() : input;
    var deps = source.deps ? Object.keys(source.deps) : [];
    deps = deps.length ? (", '" + deps.join("', '") + "'") : "";
    var module = source.isLocation ? source.path : source;
    module = module.replace(/\.js$/, '');
    return input.replace(/define\(\[/, 'define("' + module + '", [');
};
moduleDefines.onRead = true;

function build() {
    clean();
    prepareBuild();

    // Update install.rdf with updated release version info
    copy({
        source: buildDir + '/install.rdf',
        filter: function(data) {
            return data
                .replace(/@VERSION@/, version)
                .replace(/@RELEASE@/, release);
        },
        dest: buildDir + '/install.rdf'
    });

    // Remove template for manifest file that is used for Babelzilla builds
    shell.rm(buildDir + "/chrome.bz.tpl.manifest");

    // Create XPI for getfirebug.com
    createFirebugXPI("firebug-" + version + release + ".xpi");

    // Remove update URL, this is necessary for AMO
    copy({
        source: buildDir + "/install.rdf",
        filter: function(data) {
            return data.replace(/(.*)https:\/\/getfirebug.com\/releases\/firebug\/" + version + "\/update.rdf(.*)/, '');
        },
        dest: buildDir + "/install.rdf"
    });

    // Create XPI for AMO
    createFirebugXPI("firebug-" + version + release + "-amo.xpi");

    //shell.rm('-rf', buildDir);

    deploy();

    console.log("Firebug version: " + version + release + " in " + releaseDir);
}

function createFirebugXPI(filename) {
    zip(releaseDir + "/" + filename, buildDir);
    copy({
        source: 'update.rdf.tpl.xml',
        filter: function(data) {
            return data
                .replace(/@VERSION@/, version)
                .replace(/@RELEASE@/, release)
                .replace(/@LEAF@/, "firebug-" + version + release + ".xpi");
        },
        dest: releaseDir + "/update.rdf"
    });
}

function deploy() {
    if (deployDirAvailable) {
        /*
        <copy file="${releaseDir}/update.rdf" todir="${deployXpiDir}" overwrite="true"/>
        <copy file="${releaseDir}/firebug-" + version + release + ".xpi" todir="${deployXpiDir}" overwrite="true"/>
        <copy file="${releaseDir}/firebug-" + version + release + "-amo.xpi" todir="${deployXpiDir}" overwrite="true"/>
        <echo message="XPI deployed to: " + version + release + " to ${deployXpiDir}"/>
        */
    }
}

function echo() {
    console.log("Build directory: " + buildDir);
    console.log("Deploy directory: " + getfirebugDir + " available: " + deployDirAvailable);
}

/**
 * Support for generating docs from Firebug source code using js-doc-toolkit
 * See the output in $svn/jsdoc/out directory
 */
function jsdoc() {
    build();
    /*
    <property name="jsdoc.dir" value="../../jsdoc/"/>
    <property name="jsdoc-toolkit.dir" value="${jsdoc.dir}/jsdoc-toolkit-2.3.0/"/>
    <property name="jsdoc-output.dir" value="${releaseDir}/jsdoc/"/>

    <path id="jsdoctoolkit">
        <!-- Rhino js.jar 1.7.R2 must be used with jsdoctoolkit-ant-task-1.0.1.jar -->
        <fileset dir="${jsdoc.dir}" includes="*.jar"/>
    </path>

    <taskdef name="jsdoctoolkit"
        classpathref="jsdoctoolkit"
        classname="uk.co.darrenhurley.ant.tasks.JsDocToolkit"/>

    <echo message="Generate doc from Firebug source."/>

    <!-- Clean the output direcotory -->
    <delete dir="${jsdoc-output.dir}"/>

    <!-- Parse all source files -->
    <jsdoctoolkit jsdochome="${jsdoc-toolkit.dir}"
        template="firebug"
        outputdir="${jsdoc-output.dir}"
        inputdir="." />
    */
    deployJsdoc();
}

function deployJsdoc() {
    if (deployDirAvailable) {
        /*
        <copy todir="${deployJsdocDir}">
            <fileset dir="${releaseDir}/jsdoc"/>
        </copy>
  
        <echo message="JSDoc deployed to: " + version + release + " to ${deployXpiDir}"/>
         */
    }
}

function bz() {
    clean();
    prepareBuild();
    /*
    <!-- Use Babelzila manifest file (with all locales) -->
    <copy file="chrome.bz.tpl.manifest" tofile="${buildDir}/chrome.manifest"
        overwrite="true"/>
    <delete file="${buildDir}/chrome.bz.tpl.manifest"/>

    <!-- Use all BZ locales -->
    <copy todir="${buildDir}/locale" overwrite="true">
        <fileset dir="${bzLocaleDir}">
           <include name="**[      ]/*.properties"/>
           <exclude name="en-US/*.properties"/>
        </fileset>
    </copy>

    <!-- Modify version number (append BZ) -->
    <replace file="${buildDir}/install.rdf" propertyFile="content/firebug/branch.properties">
        <replacefilter token="@version@" value="" + version + "" />
        <replacefilter token="@RELEASE@" value="" + release + "-bz" />
    </replace>

    <!-- Delete the helper dir with Babelzilla locales from the build directory -->
    <delete dir="${buildDir}/${bzLocaleDir}" />

    <!-- Create XPI for getfirebug.com -->
    <antcall target="createFirebugXPI">
        <param name="file-name" value="firebug-" + version + release + "-bz.xpi" />
    </antcall>

    <delete dir="${buildDir}" />

    <echo message="Firebug Release for Babelzilla: " + version + release + "-bz in ${releaseDir}" />
    */
}

function clean() {
    shell.rm('-rf', buildDir);
    shell.rm('-rf', releaseDir);
}

function zip(filename, directory) {
  console.log('zip is not implemented. Skipping ' + filename);
}

main();
