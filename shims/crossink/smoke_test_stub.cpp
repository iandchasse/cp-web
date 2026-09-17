// CrossInk's loop() calls runSimulatorSmokeTestTick() unconditionally, but its
// implementation (src/simulator/SimulatorSmokeTest.cpp) wraps the work in
// try/catch and this build compiles with -fno-exceptions. The test only does
// anything when a command-line flag enables it, which a browser never passes,
// so build.py excludes that file for this variant and the call lands here.
//
// Files under shims/<variant>/ are compiled only into that variant; see
// excluded() in build.py.
void runSimulatorSmokeTestTick() {}
