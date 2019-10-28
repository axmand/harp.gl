/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:no-unused-expression
//    expect-type assertions are unused expressions and are perfectly valid

// tslint:disable:no-empty
//    lots of stubs are needed which are just placeholders and are empty

// tslint:disable:only-arrow-functions
//    Mocha discourages using arrow functions, see https://mochajs.org/#arrow-functions

import { Theme } from "@here/harp-datasource-protocol";
import { mercatorProjection, Projection, TileKey, Vector3Like } from "@here/harp-geoutils";
import {
    FontCatalog,
    GlyphData,
    MeasurementParameters,
    TextBufferObject,
    TextCanvas
} from "@here/harp-text-canvas";
import { Math2D } from "@here/harp-utils";
import { assert, expect } from "chai";
import * as sinon from "sinon";
import * as THREE from "three";
import { PoiManager } from "..";
import { PoiRenderer } from "../lib/poi/PoiRenderer";
import { PoiRendererFactory } from "../lib/poi/PoiRendererFactory";
import { ScreenCollisions } from "../lib/ScreenCollisions";
import { ScreenProjector } from "../lib/ScreenProjector";
import { DEFAULT_FONT_CATALOG_NAME, FontCatalogLoader } from "../lib/text/FontCatalogLoader";
import { DEFAULT_FADE_TIME } from "../lib/text/RenderState";
import { TextCanvasFactory } from "../lib/text/TextCanvasFactory";
import { PoiInfo, TextElement } from "../lib/text/TextElement";
import { TextElementsRenderer } from "../lib/text/TextElementsRenderer";
import { TextElementsRendererOptions } from "../lib/text/TextElementsRendererOptions";
import { TextElementType } from "../lib/text/TextElementType";
import { ViewState } from "../lib/text/ViewState";
import { Tile } from "../lib/Tile";
import { TileOffsetUtils } from "../lib/Utils";
import { DataSourceTileList } from "../lib/VisibleTileSet";
import { FakeOmvDataSource } from "./FakeOmvDataSource";
import { PoiInfoBuilder } from "./PoiInfoBuilder";
import {
    lineMarkerBuilder,
    pathTextBuilder,
    poiBuilder,
    pointTextBuilder,
    TextElementBuilder
} from "./TextElementBuilder";

function createViewState(worldCenter: THREE.Vector3): ViewState {
    return {
        worldCenter,
        cameraIsMoving: false,
        maxVisibilityDist: 10000,
        zoomLevel: 0,
        frameNumber: 0,
        lookAtDistance: 0,
        isDynamic: false,
        hiddenGeometryKinds: undefined,
        renderedTilesChanged: false
    };
}

type OpacityMatcher = (opacity: number) => boolean;

const SCREEN_WIDTH = 1920;
const SCREEN_HEIGHT = 1080;
const DEF_TEXT_WIDTH_HEIGHT = 10;
const DEF_TEXTURE_SIZE = 1;
const TILE_LEVEL = 5;

class TestFixture {
    readonly screenCollisions: ScreenCollisions;
    projection: Projection = mercatorProjection;

    viewState: ViewState;
    options: TextElementsRendererOptions = {};
    readonly tileLists: DataSourceTileList[] = [];

    private m_canvasAddTextStub: sinon.SinonStub | undefined;
    private m_canvasAddBufferObjStub: sinon.SinonStub | undefined;
    private m_poiRendererStub: sinon.SinonStubbedInstance<PoiRenderer>;
    private m_screenCollisionsIsAllocatedStub: sinon.SinonStub | undefined;
    private m_renderPoiSpy: sinon.SinonSpy;
    private m_dataSource: FakeOmvDataSource = new FakeOmvDataSource();
    private m_screenProjector: ScreenProjector;
    private readonly m_camera: THREE.PerspectiveCamera = new THREE.PerspectiveCamera();
    private readonly m_theme: Theme = {};
    private m_textRenderer: TextElementsRenderer | undefined;
    private m_defaultTile: Tile | undefined;
    private m_allTiles: Tile[] = [];

    constructor(readonly sandbox: sinon.SinonSandbox) {
        this.screenCollisions = new ScreenCollisions();
        this.screenCollisions.update(SCREEN_WIDTH, SCREEN_HEIGHT);
        this.viewState = createViewState(new THREE.Vector3());
        this.m_poiRendererStub = this.stubPoiRenderer();
        this.m_renderPoiSpy = this.sandbox.spy();
        this.m_screenProjector = this.stubScreenProjector();
    }

    setUp(): Promise<boolean> {
        this.m_defaultTile = this.m_dataSource.getTile(new TileKey(0, 0, TILE_LEVEL));
        this.m_defaultTile.textElementsChanged = true;
        this.m_allTiles = [];
        this.tileLists.push({
            dataSource: this.m_dataSource,
            zoomLevel: 0,
            storageLevel: 0,
            allVisibleTileLoaded: false,
            numTilesLoading: 0,
            visibleTiles: [this.m_defaultTile],
            renderedTiles: new Map([[1, this.m_defaultTile]])
        });

        const cameraPosition = new THREE.Vector3(0, 0, 0); // center.

        this.viewState = createViewState(cameraPosition);
        this.options = {
            labelDistanceScaleMin: 1, // Disable scaling by default.
            labelDistanceScaleMax: 1
        };

        const fontCatalog = this.stubFontCatalog();
        const fontCatalogLoader = this.stubFontCatalogLoader(fontCatalog);
        const textCanvasFactory = this.stubTextCanvasFactory(fontCatalog);
        const poiManager = this.stubPoiManager();
        const poiRendererFactory = this.stubPoiRendererFactory(this.m_poiRendererStub);
        const dummyUpdateCall = () => {};

        this.m_textRenderer = new TextElementsRenderer(
            this.viewState,
            this.m_camera,
            dummyUpdateCall,
            this.screenCollisions,
            this.m_screenProjector,
            textCanvasFactory,
            poiManager,
            poiRendererFactory,
            fontCatalogLoader,
            this.m_theme,
            this.options
        );

        // Force renderer initialization by calling render with changed text elements.
        const time = 0;
        this.m_textRenderer.placeText(this.tileLists, this.projection, time);
        this.clearVisibleTiles();
        return this.m_textRenderer.waitInitialized();
    }

    get textRenderer(): TextElementsRenderer {
        assert(this.m_textRenderer !== undefined);
        return this.m_textRenderer!;
    }

    checkTextElementRendered(
        textElement: TextElement,
        opacityMatcher: OpacityMatcher | undefined
    ): number {
        switch (textElement.type) {
            case TextElementType.PoiLabel:
                if (textElement.poiInfo !== undefined) {
                    return this.checkPoiRendered(textElement, opacityMatcher);
                } else {
                    return this.checkPointTextRendered(textElement, opacityMatcher);
                }
            case TextElementType.PathLabel:
                return this.checkPathTextRendered(textElement, opacityMatcher);
            case TextElementType.LineMarker:
                return this.checkLineMarkerRendered(textElement, opacityMatcher);
        }
    }

    checkTextElementNotRendered(textElement: TextElement) {
        switch (textElement.type) {
            case TextElementType.PoiLabel:
                if (textElement.poiInfo !== undefined) {
                    return this.checkPoiNotRendered(textElement);
                } else {
                    return this.checkPointTextNotRendered(textElement);
                }
            case TextElementType.PathLabel:
                return this.checkPathTextNotRendered(textElement);
            case TextElementType.LineMarker:
                return this.checkLineMarkerNotRendered(textElement);
        }
    }

    checkTextElementState(
        textElement: TextElement,
        expectedState: FadeState,
        prevOpacity: number
    ): number {
        let newOpacity = 0;
        switch (expectedState) {
            case FadeState.FadingIn:
                newOpacity = this.checkTextElementRendered(textElement, (opacity: number) => {
                    return opacity > prevOpacity;
                });
                break;
            case FadeState.FadingOut:
                newOpacity = this.checkTextElementRendered(textElement, (opacity: number) => {
                    return opacity < prevOpacity;
                });
                break;
            case FadeState.FadedIn:
                newOpacity = this.checkTextElementRendered(textElement, (opacity: number) => {
                    return opacity === 1;
                });
                break;
            case FadeState.FadedOut:
                this.checkTextElementNotRendered(textElement);
                break;
        }
        return newOpacity;
    }

    addTile(elements: TextElement[]) {
        const tile =
            this.m_allTiles.length > 0
                ? this.m_dataSource.getTile(
                      new TileKey(
                          this.m_allTiles[this.m_allTiles.length - 1].tileKey.row + 1,
                          0,
                          TILE_LEVEL
                      )
                  )
                : this.m_defaultTile!;
        for (const element of elements) {
            tile.addTextElement(element);
        }
        this.m_allTiles.push(tile);
    }

    async renderFrame(time: number, indices: number[], collisionEnabled: boolean = true) {
        this.sandbox.resetHistory();

        if (collisionEnabled && this.m_screenCollisionsIsAllocatedStub !== undefined) {
            this.m_screenCollisionsIsAllocatedStub.restore();
            this.m_screenCollisionsIsAllocatedStub = undefined;
        } else if (!collisionEnabled && this.m_screenCollisionsIsAllocatedStub === undefined) {
            this.m_screenCollisionsIsAllocatedStub = (this.sandbox
                .stub(this.screenCollisions, "isAllocated")
                .returns(false) as unknown) as sinon.SinonStub;
        }

        if (this.textRenderer.loading) {
            await this.textRenderer.waitLoaded();
        }
        this.viewState.renderedTilesChanged = false;
        if (indices !== undefined) {
            this.viewState.renderedTilesChanged = this.setVisibleTiles(indices);
        }

        this.viewState.frameNumber++;
        this.textRenderer.placeText(this.tileLists, this.projection, time);
    }

    private setVisibleTiles(indices: number[]): boolean {
        const newVisibleTiles = indices.map((tileIdx: number) => {
            return this.m_allTiles[tileIdx];
        });

        let changed = indices.length !== this.visibleTiles.length;

        if (!changed) {
            for (let i = 0; i < this.visibleTiles.length; ++i) {
                const oldTile = this.visibleTiles[i];
                const newTile = this.m_allTiles[indices[i]];
                if (oldTile !== newTile) {
                    changed = true;
                    break;
                }
            }
        }

        if (!changed) {
            return false;
        }
        this.visibleTiles = newVisibleTiles;
        return true;
    }

    private clearVisibleTiles() {
        this.tileLists[0].visibleTiles.length = 0;
        this.tileLists[0].renderedTiles.clear();
    }

    private get visibleTiles(): Tile[] {
        return this.tileLists[0].visibleTiles;
    }

    private set visibleTiles(tiles: Tile[]) {
        this.tileLists[0].visibleTiles = tiles;
        this.tileLists[0].renderedTiles.clear();
        for (const tile of tiles) {
            this.tileLists[0].renderedTiles.set(
                TileOffsetUtils.getKeyForTileKeyAndOffset(tile.tileKey, 0),
                tile
            );
        }
    }

    private checkPointTextRendered(
        textElement: TextElement,
        opacityMatcher: OpacityMatcher | undefined
    ): number {
        const addBufferObjSpy = this.m_canvasAddBufferObjStub!.withArgs(
            sinon.match.same(textElement.textBufferObject),
            sinon.match.any
        );

        assert(
            addBufferObjSpy.calledOnce,
            this.getErrorHeading(textElement) + "point text was NOT rendered."
        );

        const actualOpacity = addBufferObjSpy.firstCall.args[1].opacity;
        this.checkOpacity(actualOpacity, textElement, "text", opacityMatcher);
        return actualOpacity;
    }

    private checkPointTextNotRendered(textElement: TextElement) {
        assert(
            this.m_canvasAddBufferObjStub!.neverCalledWith(
                sinon.match.same(textElement.textBufferObject),
                sinon.match.any
            ),
            this.getErrorHeading(textElement) + "point text was rendered."
        );
    }

    private checkIconRendered(
        textElement: TextElement,
        opacityMatcher: OpacityMatcher | undefined,
        positionIndex?: number
    ): number {
        const screenCoords = this.computeScreenCoordinates(textElement, positionIndex);
        expect(screenCoords).to.exist;
        assert(
            this.m_renderPoiSpy.calledWith(
                sinon.match.same(textElement.poiInfo),
                sinon.match.any,
                sinon.match.any
            ),
            this.getErrorHeading(textElement) + "icon was NOT rendered."
        );

        const renderPoiSpy = this.m_renderPoiSpy.withArgs(
            sinon.match.same(textElement.poiInfo),
            sinon.match.array.deepEquals(screenCoords!.toArray()),
            sinon.match.any
        );

        assert(
            renderPoiSpy.called,
            this.getErrorHeading(textElement) +
                "icon was NOT rendered in expected position " +
                JSON.stringify(screenCoords)
        );

        const actualOpacity = renderPoiSpy.firstCall.args[2];
        let labelPartDescription: string = "icon";
        if (positionIndex !== undefined) {
            labelPartDescription += " " + positionIndex;
        }
        this.checkOpacity(actualOpacity, textElement, labelPartDescription, opacityMatcher);
        return actualOpacity;
    }

    private checkIconNotRendered(textElement: TextElement, positionIndex?: number) {
        const screenCoords = this.computeScreenCoordinates(textElement, positionIndex);
        expect(
            this.m_renderPoiSpy.neverCalledWith(
                sinon.match.same(textElement.poiInfo),
                sinon.match
                    .typeOf("undefined")
                    .or(sinon.match.array.deepEquals(screenCoords!.toArray())),
                sinon.match.any
            ),
            this.getErrorHeading(textElement) + "icon was rendered."
        );
    }

    private checkPoiRendered(
        textElement: TextElement,
        opacityMatcher: OpacityMatcher | undefined
    ): number {
        this.checkPointTextRendered(textElement, opacityMatcher);
        return this.checkIconRendered(textElement, opacityMatcher);
    }

    private checkPoiNotRendered(textElement: TextElement) {
        this.checkPointTextNotRendered(textElement);
        this.checkIconNotRendered(textElement);
    }

    private checkLineMarkerRendered(
        textElement: TextElement,
        opacityMatcher: OpacityMatcher | undefined
    ): number {
        let actualOpacity: number = 0;
        for (let i = 0; i < textElement.path!.length; ++i) {
            actualOpacity = this.checkIconRendered(textElement, opacityMatcher, i);
        }
        return actualOpacity;
    }

    private checkLineMarkerNotRendered(textElement: TextElement) {
        for (let i = 0; i < textElement.path!.length; ++i) {
            this.checkIconNotRendered(textElement, i);
        }
    }

    private checkPathTextRendered(
        textElement: TextElement,
        opacityMatcher: OpacityMatcher | undefined
    ): number {
        const addTextSpy = this.m_canvasAddTextStub!.withArgs(
            sinon.match.same(textElement.glyphs),
            sinon.match.any,
            sinon.match.any
        );

        const opacitySpy = Object.getOwnPropertyDescriptor(textElement.renderStyle, "opacity")!
            .set! as sinon.SinonSpy;

        assert(opacitySpy.called, this.getErrorHeading(textElement) + "opacity not set");
        assert(
            addTextSpy.calledOnce,
            this.getErrorHeading(textElement) + "path text was NOT rendered."
        );

        const firstOpacityCallSpy = opacitySpy.firstCall;

        assert(
            firstOpacityCallSpy.calledBefore(addTextSpy.firstCall),
            this.getErrorHeading(textElement) + ", opacity not set before addText"
        );

        const actualOpacity = firstOpacityCallSpy.args[0];

        this.checkOpacity(actualOpacity, textElement, "text", opacityMatcher);
        return actualOpacity;
    }

    private checkPathTextNotRendered(textElement: TextElement) {
        expect(
            this.m_canvasAddTextStub!.neverCalledWith(
                sinon.match.same(textElement.glyphs),
                sinon.match.any,
                sinon.match.any
            ),
            this.getErrorHeading(textElement) + "path text was rendered."
        );
    }

    private computeScreenCoordinates(
        textElement: TextElement,
        positionIndex?: number
    ): THREE.Vector2 | undefined {
        if (positionIndex !== undefined) {
            expect(textElement.path).exist;
        }
        const worldCoords =
            positionIndex !== undefined ? textElement.path![positionIndex] : textElement.position;
        return this.m_screenProjector!.project(worldCoords);
    }

    private checkOpacity(
        actualOpacity: number,
        textElement: TextElement,
        labelPartDescription: string,
        opacityMatcher: OpacityMatcher | undefined
    ) {
        const errorMessage =
            this.getErrorHeading(textElement) +
            "has wrong " +
            labelPartDescription +
            " opacity " +
            actualOpacity;
        expect(actualOpacity, errorMessage)
            .gte(0)
            .and.lte(1);

        if (opacityMatcher !== undefined) {
            assert(opacityMatcher(actualOpacity), errorMessage);
        }
    }

    private getErrorHeading(textElement: TextElement): string {
        // Substract first initialization frame and 1 more because The view state hold the number
        // of the next frame.
        const currentFrame = this.viewState.frameNumber - 2;
        return "Frame " + currentFrame + ", label '" + textElement.text + "': ";
    }

    private stubScreenProjector(): ScreenProjector {
        const screenProjector = new ScreenProjector(this.m_camera);
        screenProjector.update(this.m_camera, SCREEN_WIDTH, SCREEN_HEIGHT);

        // Creates a fake projector that takes as input NDC coordinates (from -1 to 1) and outputs
        // screen coordinates.
        this.sandbox
            .stub(screenProjector, "projectVector")
            .callsFake(function(source: Vector3Like, target: THREE.Vector3) {
                target.set(source.x, source.y, source.z);
                return target;
            });
        return screenProjector;
    }

    private stubFontCatalog(): FontCatalog {
        const fontCatalogStub = sinon.createStubInstance(FontCatalog);
        this.sandbox.stub(fontCatalogStub, "isLoading").get(() => {
            return false;
        });
        const defaultTextureSize = new THREE.Vector2(DEF_TEXTURE_SIZE, DEF_TEXTURE_SIZE);
        this.sandbox.stub(fontCatalogStub, "textureSize").get(() => {
            return defaultTextureSize;
        });
        const defaultTexture = new THREE.Texture();
        this.sandbox.stub(fontCatalogStub, "texture").get(() => {
            return defaultTexture;
        });
        fontCatalogStub.loadCharset.resolves([]);
        fontCatalogStub.getGlyphs.callsFake(() => {
            return [(sinon.createStubInstance(GlyphData) as unknown) as GlyphData];
        });

        return (fontCatalogStub as unknown) as FontCatalog;
    }
    private stubFontCatalogLoader(fontCatalog: FontCatalog): FontCatalogLoader {
        const fontCatalogLoaderStub = sinon.createStubInstance(FontCatalogLoader);

        this.sandbox.stub(fontCatalogLoaderStub, "loading").get(() => {
            return false;
        });
        fontCatalogLoaderStub.loadCatalogs
            .yields([DEFAULT_FONT_CATALOG_NAME, fontCatalog])
            .resolves([]);

        return (fontCatalogLoaderStub as unknown) as FontCatalogLoader;
    }

    private stubTextCanvasFactory(fontCatalog: FontCatalog): TextCanvasFactory {
        const renderer = ({} as unknown) as THREE.WebGLRenderer;
        const textCanvas = new TextCanvas({
            renderer,
            fontCatalog,
            minGlyphCount: 1,
            maxGlyphCount: 1
        });

        this.m_canvasAddTextStub = (this.sandbox
            .stub(textCanvas, "addText")
            .returns(true) as unknown) as sinon.SinonStub;
        this.sandbox
            .stub(textCanvas, "measureText")
            .callsFake(
                (
                    _text: string | GlyphData[],
                    outputBounds: THREE.Box2,
                    params: MeasurementParameters | undefined
                ) => {
                    // Return a box centered on origin with dimensions DEF_TEXT_WIDTH_HEIGHT
                    outputBounds.set(
                        new THREE.Vector2(-DEF_TEXT_WIDTH_HEIGHT / 2, -DEF_TEXT_WIDTH_HEIGHT / 2),
                        new THREE.Vector2(DEF_TEXT_WIDTH_HEIGHT / 2, DEF_TEXT_WIDTH_HEIGHT / 2)
                    );
                    // Same bbox for character bounds, as if text had a single character.
                    if (params !== undefined && params.outputCharacterBounds !== undefined) {
                        params.outputCharacterBounds.push(outputBounds.clone());
                    }
                    return true;
                }
            );
        this.sandbox.stub(textCanvas, "createTextBufferObject").callsFake(() => {
            return new TextBufferObject([], new Float32Array());
        });
        this.m_canvasAddBufferObjStub = (this.sandbox
            .stub(textCanvas, "addTextBufferObject")
            .returns(true) as unknown) as sinon.SinonStub;
        this.sandbox.stub(textCanvas, "render"); // do nothing.

        const textCanvasFactoryStub = this.sandbox.createStubInstance(TextCanvasFactory);
        textCanvasFactoryStub.createTextCanvas.returns((textCanvas as unknown) as TextCanvas);

        return (textCanvasFactoryStub as unknown) as TextCanvasFactory;
    }

    private stubPoiManager(): PoiManager {
        const stub = this.sandbox.createStubInstance(PoiManager);
        stub.updatePoiFromPoiTable.returns(true);

        return (stub as unknown) as PoiManager;
    }

    private stubPoiRenderer(): sinon.SinonStubbedInstance<PoiRenderer> {
        const stub = this.sandbox.createStubInstance(PoiRenderer);
        stub.prepareRender.returns(true);
        // TODO: Refactor PoiRenderer.computeIconScreenBox to reuse it's implementation,
        // without needing the render buffer.
        stub.computeIconScreenBox.callsFake(
            (
                poiInfo: PoiInfo,
                screenPosition: THREE.Vector2,
                scale: number,
                _zoomLevel: number,
                screenBox: Math2D.Box
            ) => {
                const technique = poiInfo.technique;
                const iconXOffset =
                    typeof technique.iconXOffset === "number" ? technique.iconXOffset : 0;
                const iconYOffset =
                    typeof technique.iconYOffset === "number" ? technique.iconYOffset : 0;
                const centerX = screenPosition.x + iconXOffset;
                const centerY = screenPosition.y + iconYOffset;
                const width = poiInfo.computedWidth! * scale;
                const height = poiInfo.computedHeight! * scale;
                screenBox.x = centerX - width / 2;
                screenBox.y = centerY - height / 2;
                screenBox.w = width;
                screenBox.h = height;
                return true;
            }
        );

        // Workaround to capture the value of screenPosition vector on the time of the call,
        // otherwise it's lost afterwards since the same vector is used to pass positions for
        // other pois.
        stub.renderPoi.callsFake(
            (
                poiInfo: PoiInfo,
                screenPosition: THREE.Vector2,
                screenCollisions: ScreenCollisions,
                _viewDistance: number,
                scale: number,
                allocateScreenSpace: boolean,
                opacity: number,
                zoomLevel: number
            ) => {
                // TODO: HARP-7648 Refactor PoiRenderer.renderPoi, to take out
                // bbox computation(already done during placement) and screen allocation (should
                // be done during placement instead).
                const bbox = new Math2D.Box();
                this.m_poiRendererStub.computeIconScreenBox(
                    poiInfo,
                    screenPosition,
                    scale,
                    zoomLevel,
                    bbox
                );
                if (allocateScreenSpace) {
                    screenCollisions.allocate(bbox);
                }
                const screenPosCopy = screenPosition.toArray();
                this.m_renderPoiSpy(poiInfo, screenPosCopy, opacity);
            }
        );
        return stub;
    }

    private stubPoiRendererFactory(
        poiRendererStub: sinon.SinonStubbedInstance<PoiRenderer>
    ): PoiRendererFactory {
        const factoryStub = this.sandbox.createStubInstance(PoiRendererFactory);
        factoryStub.createPoiRenderer.returns((poiRendererStub as unknown) as PoiRenderer);

        return (factoryStub as unknown) as PoiRendererFactory;
    }
}

// time must not be 0 b/c 0 is used as a special value in TextElementsRenderer.
const INITIAL_TIME: number = 1;

enum FadeState {
    FadingIn,
    FadedIn,
    FadingOut,
    FadedOut
}

const FADE_CYCLE: number[] = [
    INITIAL_TIME,
    INITIAL_TIME + DEFAULT_FADE_TIME / 3,
    INITIAL_TIME + DEFAULT_FADE_TIME / 2,
    INITIAL_TIME + DEFAULT_FADE_TIME
];

const FADE_2_CYCLES: number[] = fadeNCycles(2);

function fadeNCycles(n: number): number[] {
    if (n === 0) {
        return [];
    }

    let result = FADE_CYCLE.slice();
    for (let i = 1; i < n; ++i) {
        result = result.concat(FADE_CYCLE.slice(1).map(x => x + i * DEFAULT_FADE_TIME));
    }
    return result;
}

const FADE_IN: FadeState[] = [
    FadeState.FadedOut,
    FadeState.FadingIn,
    FadeState.FadingIn,
    FadeState.FadedIn
];

const FADE_OUT: FadeState[] = [FadeState.FadingOut, FadeState.FadingOut, FadeState.FadedOut];

const FADE_IN_OUT: FadeState[] = FADE_IN.concat(FADE_OUT);

function fadedIn(frames: number): FadeState[] {
    return new Array<FadeState>(frames).fill(FadeState.FadedIn);
}

function fadedOut(frames: number): FadeState[] {
    return new Array<FadeState>(frames).fill(FadeState.FadedOut);
}

function fadeIn(frames: number): FadeState[] {
    if (frames < FADE_IN.length) {
        return FADE_IN.slice(0, frames);
    }
    return FADE_IN.concat(fadedIn(frames - FADE_IN.length));
}

function fadeOut(frames: number): FadeState[] {
    if (frames < FADE_OUT.length) {
        return FADE_OUT.slice(0, frames);
    }
    return FADE_OUT.concat(fadedOut(frames - FADE_OUT.length));
}

function firstNFrames(frames: number[], n: number): boolean[] {
    return new Array<boolean>(frames.length).fill(false).fill(true, 0, n);
}

function not(input: boolean[]): boolean[] {
    return input.map(function(e: boolean) {
        return !e;
    });
}

function lastNFrames(frames: number[], n: number): boolean[] {
    return new Array<boolean>(frames.length).fill(false).fill(true, -n);
}

function allFrames(frames: number[]): boolean[] {
    return new Array<boolean>(frames.length).fill(true);
}

type InputTextElement = [TextElementBuilder, FadeState[]];

function builder(input: InputTextElement) {
    return input[0];
}

function frameStates(input: InputTextElement) {
    return input[1];
}

interface InputTile {
    labels: InputTextElement[];
    frames?: boolean[]; // Frames where tile will be visited (default: all)
}

interface TestCase {
    name: string;
    tiles: InputTile[];
    frameTimes: number[];
    collisionFrames?: boolean[];
}

const tests: TestCase[] = [
    // SINGLE LABEL TEST CASES
    {
        name: "Newly visited, visible point text fades in",
        tiles: [{ labels: [[pointTextBuilder(), FADE_IN]] }],
        frameTimes: FADE_CYCLE
    },
    {
        name: "Newly visited, visible poi fades in",
        tiles: [{ labels: [[poiBuilder(), FADE_IN]] }],
        frameTimes: FADE_CYCLE
    },
    {
        name: "Newly visited, visible line marker fades in",
        tiles: [{ labels: [[lineMarkerBuilder(), FADE_IN]] }],
        frameTimes: FADE_CYCLE
    },
    {
        name: "Newly visited, visible path text fades in",
        tiles: [{ labels: [[pathTextBuilder(), FADE_IN]] }],
        frameTimes: FADE_CYCLE
    },
    {
        name: "Non-visited, persistent point text fades out",
        tiles: [
            { labels: [[pointTextBuilder(), FADE_IN_OUT]], frames: firstNFrames(FADE_2_CYCLES, 3) }
        ],
        frameTimes: FADE_2_CYCLES
    },
    {
        name: "Non-visited, persistent poi fades out",
        tiles: [{ labels: [[poiBuilder(), FADE_IN_OUT]], frames: firstNFrames(FADE_2_CYCLES, 3) }],
        frameTimes: FADE_2_CYCLES
    },
    {
        name: "Non-visited, persistent line marker fades out",
        tiles: [
            { labels: [[lineMarkerBuilder(), FADE_IN_OUT]], frames: firstNFrames(FADE_2_CYCLES, 3) }
        ],
        frameTimes: FADE_2_CYCLES
    },
    {
        // TODO: HARP-7649. Add fade out transitions for path labels.
        name: "Non-visited, persistent path text fades out",
        tiles: [
            {
                labels: [
                    [
                        pathTextBuilder(),
                        FADE_IN.slice(0, -1).concat(fadedOut(FADE_OUT.length + 1)) /*FADE_IN_OUT*/
                    ]
                ],
                frames: firstNFrames(FADE_2_CYCLES, 3)
            }
        ],
        frameTimes: FADE_2_CYCLES
    },
    // LABEL COLLISIONS
    {
        name: "Least prioritized from two colliding persistent point texts fades out",
        tiles: [
            {
                labels: [
                    [pointTextBuilder("P0").withPriority(0), FADE_IN_OUT],
                    [pointTextBuilder("P1").withPriority(1), fadeIn(FADE_IN_OUT.length)]
                ]
            }
        ],
        frameTimes: FADE_2_CYCLES,
        collisionFrames: not(firstNFrames(FADE_2_CYCLES, 3))
    },
    {
        name: "Least prioritized from two colliding persistent pois fades out",
        tiles: [
            {
                labels: [
                    [poiBuilder("P0").withPriority(0), FADE_IN_OUT],
                    [poiBuilder("P1").withPriority(1), fadeIn(FADE_IN_OUT.length)]
                ]
            }
        ],
        frameTimes: FADE_2_CYCLES,
        collisionFrames: not(firstNFrames(FADE_2_CYCLES, 3))
    },
    {
        // TODO: HARP-7649. Add fade out transitions for path labels.
        name: "Least prioritized from two colliding persistent path texts fades out",
        tiles: [
            {
                labels: [
                    [
                        pathTextBuilder("P0").withPriority(0),
                        FADE_IN.slice(0, -1).concat(fadedOut(FADE_OUT.length + 1)) /*FADE_IN_OUT*/
                    ],
                    [pathTextBuilder("P1").withPriority(1), fadeIn(FADE_IN_OUT.length)]
                ]
            }
        ],
        frameTimes: FADE_2_CYCLES,
        collisionFrames: not(firstNFrames(FADE_2_CYCLES, 3))
    },
    {
        name: "Least prioritized from two colliding persistent line markers fades out",
        tiles: [
            {
                labels: [
                    [lineMarkerBuilder("P0").withPriority(0), FADE_IN_OUT],
                    [lineMarkerBuilder("P1").withPriority(1), fadeIn(FADE_IN_OUT.length)]
                ]
            }
        ],
        frameTimes: FADE_2_CYCLES,
        collisionFrames: not(firstNFrames(FADE_2_CYCLES, 3))
    },
    {
        name: "Least prioritized from two persistent pois colliding on text fades out",
        tiles: [
            {
                labels: [
                    [
                        poiBuilder("P0")
                            .withPriority(0)
                            .withPoiInfo(
                                new PoiInfoBuilder()
                                    .withPoiTechnique()
                                    .withIconOffset(SCREEN_WIDTH * 0.25, 0)
                            ),
                        FADE_IN_OUT
                    ],
                    [
                        poiBuilder("P1")
                            .withPriority(1)
                            .withPoiInfo(
                                new PoiInfoBuilder()
                                    .withPoiTechnique()
                                    .withIconOffset(-SCREEN_WIDTH * 0.25, 0)
                            ),
                        fadeIn(FADE_IN_OUT.length)
                    ]
                ]
            }
        ],
        frameTimes: FADE_2_CYCLES,
        collisionFrames: not(firstNFrames(FADE_2_CYCLES, 3))
    },
    // DEDUPLICATION
    {
        name: "Second from two near, non-colliding point labels with same text never fades in",
        tiles: [
            {
                labels: [
                    [
                        pointTextBuilder().withPosition(
                            (4 * DEF_TEXT_WIDTH_HEIGHT) / SCREEN_WIDTH,
                            (4 * DEF_TEXT_WIDTH_HEIGHT) / SCREEN_HEIGHT
                        ),
                        fadeIn(FADE_IN_OUT.length)
                    ],
                    [pointTextBuilder(), fadedOut(FADE_IN_OUT.length)]
                ]
            }
        ],
        frameTimes: FADE_2_CYCLES
    },
    {
        name: "Second from two near, non-colliding pois with same text never fades in",
        tiles: [
            {
                labels: [
                    [
                        poiBuilder().withPosition(
                            (4 * DEF_TEXT_WIDTH_HEIGHT) / SCREEN_WIDTH,
                            (4 * DEF_TEXT_WIDTH_HEIGHT) / SCREEN_HEIGHT
                        ),
                        fadeIn(FADE_IN_OUT.length)
                    ],
                    [poiBuilder(), fadedOut(FADE_IN_OUT.length)]
                ]
            }
        ],
        frameTimes: FADE_2_CYCLES
    },
    // PERSISTENCY ACROSS ZOOM LEVELS
    {
        // TODO: HARP-7373. Label persistency across zoom levels.
        // New label should replace its predecessor without any fading.
        name: "Poi replacement fades in after predecessor fades out",
        tiles: [
            {
                labels: [[poiBuilder("T1"), fadeIn(3).concat(fadedOut(FADE_2_CYCLES.length - 3))]],
                frames: firstNFrames(FADE_2_CYCLES, 2)
            },
            {
                labels: [[poiBuilder("T2"), fadedOut(3).concat(fadeIn(FADE_2_CYCLES.length - 3))]],
                frames: not(firstNFrames(FADE_2_CYCLES, 2))
            }
        ],
        frameTimes: FADE_2_CYCLES
    }
];

/**
 * MISSING TESTS
 *
 * - Test scaling with camera distance.
 * - Checking there's no placement after limits reached.
 */

describe("TextElementsRenderer", function() {
    const inNodeContext = typeof window === "undefined";

    let fixture: TestFixture;
    const sandbox = sinon.createSandbox();

    beforeEach(async function() {
        if (inNodeContext) {
            (global as any).window = { location: { href: "http://harp.gl" } };
        }

        fixture = new TestFixture(sandbox);
        const setupDone = await fixture.setUp();
        assert(setupDone, "Setup failed.");
    });

    afterEach(function() {
        sandbox.restore();
        if (inNodeContext) {
            delete (global as any).window;
        }
    });

    async function initTest(
        test: TestCase
    ): Promise<{
        textElementMap: Map<InputTextElement, TextElement>;
        opacityMap: Map<TextElement, number>;
    }> {
        const textElementMap = new Map<InputTextElement, TextElement>();
        const opacityMap = new Map<TextElement, number>();

        const allTileIndices: number[] = [];
        test.tiles.forEach((tile: InputTile, tileIndex: number) => {
            if (tile.frames !== undefined) {
                expect(tile.frames.length).equal(test.frameTimes.length);
            }
            const elements = tile.labels.map((inputElement: InputTextElement) => {
                expect(frameStates(inputElement).length).equal(test.frameTimes.length);
                const element = builder(inputElement).build(sandbox);
                textElementMap.set(inputElement, element);
                opacityMap.set(element, 0);
                return element;
            });
            allTileIndices.push(tileIndex);
            fixture.addTile(elements);
        });

        // Extra frame to load glyphs.
        await fixture.renderFrame(INITIAL_TIME, allTileIndices);
        return { textElementMap, opacityMap };
    }

    for (const test of tests) {
        it(test.name, async function() {
            const { textElementMap, opacityMap } = await initTest(test);

            for (let frameIdx = 0; frameIdx < test.frameTimes.length; ++frameIdx) {
                const frameTileIndices = test.tiles
                    .map((tile: InputTile, index: number) => {
                        return tile.frames === undefined || tile.frames[frameIdx] ? index : -1;
                    })
                    .filter(index => index >= 0);

                const frameTime = test.frameTimes[frameIdx];
                const collisionEnabled =
                    test.collisionFrames === undefined ? true : test.collisionFrames[frameIdx];
                await fixture.renderFrame(frameTime, frameTileIndices, collisionEnabled);

                for (const [inputElement, textElement] of textElementMap.entries()) {
                    const expectedState = frameStates(inputElement)[frameIdx];

                    const prevOpacity = opacityMap.get(textElement)!;
                    const newOpacity = fixture.checkTextElementState(
                        textElement,
                        expectedState,
                        prevOpacity
                    );
                    opacityMap.set(textElement, newOpacity);
                }
            }
        });
    }
});
